// ─── Execution Pool ───────────────────────────────────────────────────────────
// Workers know which file they own. They read the project before writing.
// No more reinventing the wheel — each worker builds on what exists.

import { generate, stripThinking } from "../ollama.js";
import { readyTasks } from "../planner/index.js";
import type { TaskGraph, Task, TaskResult, WorkerType } from "../types.js";
import { mkdir, writeFile, readFile, readdir } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { Sandbox } from "../sandbox/index.js";
import { runAgenticWorker } from "./agent.js";

export interface ExecutionContext {
  outputDir: string;
  projectName: string;
  language: string;
  priorContext?: string;
}

// ─── Model assignments ────────────────────────────────────────────────────────
// qwen2.5-coder:14b → all code/test/debug (specialized, outperforms general on code)
// qwen3:14b         → review pass (strong reasoning for critique)
// qwen3:8b          → docs, lightweight tasks (fast, good enough)

const MODELS = {
  coder: "qwen2.5-coder:14b",
  reviewer: "qwen3:14b",
  light: "qwen3:8b",
} as const;

const WORKER_MODEL: Record<WorkerType, string> = {
  code_gen:    MODELS.coder,
  test_runner: MODELS.coder,
  debugger:    MODELS.coder,
  doc_writer:  MODELS.light,
  file_ops:    MODELS.light,
};

// ─── File dependency graph validation ────────────────────────────────────────
// Parse file descriptions for import patterns and verify referenced files are planned.

export function validateFileMap(graph: TaskGraph): string[] {
  const warnings: string[] = [];
  const plannedPaths = new Set(graph.fileMap.map(f => f.path));
  const tasksByFile = new Map<string, boolean>(
    graph.tasks.filter(t => t.targetFile).map(t => [t.targetFile!, true])
  );

  // Patterns that indicate a file references another file
  const refPatterns = [
    /imports?\s+(?:from\s+)?['"]?([a-zA-Z0-9_\-./]+\.ts)['"]?/gi,
    /uses?\s+types?\s+from\s+['"]?([a-zA-Z0-9_\-./]+\.ts)['"]?/gi,
    /depends?\s+on\s+['"]?([a-zA-Z0-9_\-./]+\.ts)['"]?/gi,
    /requires?\s+['"]?([a-zA-Z0-9_\-./]+\.ts)['"]?/gi,
  ];

  for (const file of graph.fileMap) {
    const desc = file.description;

    // Collect all referenced files from description
    const referenced = new Set<string>();
    for (const pattern of refPatterns) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(desc)) !== null) {
        const ref = m[1].replace(/^\.\//, ""); // normalize ./foo.ts → foo.ts
        // Qualify with src/ if not already qualified
        const qualified = ref.includes("/") ? ref : `src/${ref}`;
        referenced.add(qualified);
      }
    }

    for (const ref of referenced) {
      if (!plannedPaths.has(ref)) {
        warnings.push(`${file.path} references ${ref} but ${ref} has no planned task`);
      }
    }

    // Check "entry point" / "main" files have a task
    const isEntryPoint = /entry[\s-]?point|^main\b/i.test(desc);
    if (isEntryPoint && !tasksByFile.has(file.path)) {
      warnings.push(`${file.path} is marked as entry point/main but has no planned task`);
    }
  }

  return warnings;
}

// ─── TDD task tier ordering ───────────────────────────────────────────────────
// file_ops (types/interfaces) → test_runner → code_gen/debugger → doc_writer

export function getTaskTier(worker: WorkerType): number {
  switch (worker) {
    case "file_ops":    return 0;
    case "test_runner": return 1;
    case "code_gen":    return 2;
    case "debugger":    return 2;
    case "doc_writer":  return 3;
    default:            return 2;
  }
}

export async function executeGraph(
  graph: TaskGraph,
  ctx: ExecutionContext
): Promise<TaskResult[]> {
  await mkdir(ctx.outputDir, { recursive: true });

  // ── Validate file dependency graph before running any tasks ───────────────
  const validationWarnings = validateFileMap(graph);
  for (const warning of validationWarnings) {
    console.log(`  ⚠️  dependency gap: ${warning}`);
  }

  // Auto-add tasks for files referenced but missing a planned task
  const missingFileRe = /^.+ references (src\/[a-zA-Z0-9_\-./]+\.ts) but .+ has no planned task$/;
  const autoAdded = new Set<string>();
  for (const warning of validationWarnings) {
    const m = missingFileRe.exec(warning);
    if (m) {
      const missing = m[1];
      if (!autoAdded.has(missing) && !graph.tasks.find(t => t.targetFile === missing)) {
        graph.tasks.push({
          id: `auto-${missing}`,
          worker: "code_gen",
          description: `Implement ${missing}`,
          targetFile: missing,
          dependsOn: [],
          status: "pending",
          exports: [],
          context: { files: [], notes: "" },
        });
        autoAdded.add(missing);
        console.log(`  ➕ auto-added task for missing dependency: ${missing}`);
      }
    }
  }

  // Spin up sandbox for this run
  const sandbox = new Sandbox(ctx.outputDir, ctx.language);
  await sandbox.setup();

  // Write the file map as a reference for workers
  await writeFile(
    join(ctx.outputDir, ".arkos-filemap.json"),
    JSON.stringify(graph.fileMap, null, 2),
    "utf-8"
  );

  const results: TaskResult[] = [];
  const builtContext: string[] = []; // carry-forward context, compressed as needed

  while (true) {
    const allReady = readyTasks(graph);
    if (allReady.length === 0) break;

    // TDD ordering: pick only the lowest-tier tasks in this batch
    allReady.sort((a, b) => getTaskTier(a.worker) - getTaskTier(b.worker));
    const currentTier = getTaskTier(allReady[0].worker);
    const ready = allReady.filter(t => getTaskTier(t.worker) === currentTier);

    const contextSnapshot = builtContext.join("\n\n");

    const fileMapSummary = graph.fileMap
      .map(f => `  ${f.path} — ${f.description} [exports: ${f.exports.join(", ") || "none"}]`)
      .join("\n");

    const batchResults = await Promise.all(
      ready.map(async (task) => {
        task.status = "running";
        console.log(`  → [${task.worker}] ${task.targetFile ?? task.description}`);
        try {
          // Read existing files for context
          const existingCode = await readExistingFiles(ctx.outputDir, graph, task);

          // Use agentic worker — multi-turn with real sandbox execution
          const agentResult = await runAgenticWorker(
            task,
            sandbox,
            fileMapSummary,
            contextSnapshot,
            existingCode
          );

          if (agentResult.turns > 1) {
            console.log(`    ↻ fixed in ${agentResult.turns} turns (tools: ${agentResult.toolsUsed.join(", ")})`);
          }

          task.status = "complete";
          return {
            taskId: task.id,
            output: agentResult.output,
            confidence: agentResult.confidence,
            worker: task.worker,
          } satisfies TaskResult;
        } catch (err) {
          task.status = "failed";
          console.error(`  ✗ [${task.worker}] failed: ${err}`);
          return {
            taskId: task.id,
            output: `Error: ${err}`,
            confidence: 0.1,
            worker: task.worker,
          } satisfies TaskResult;
        }
      })
    );

    // Accumulate context from completed tasks
    for (const r of batchResults) {
      if (r.confidence > 0.5 && r.output.length > 100) {
        const task = graph.tasks.find(t => t.id === r.taskId);
        builtContext.push(`[${task?.targetFile ?? r.worker}]\n${r.output.slice(0, 800)}`);
      }
    }

    // Compress context if growing large
    const fullContext = builtContext.join("\n\n");
    if (fullContext.length > 2500 && readyTasks(graph).length > 0) {
      try {
        const { compressContext } = await import("../optimizer/index.js");
        const nextTask = readyTasks(graph)[0];
        const result = await compressContext(fullContext, nextTask?.description ?? "next task");
        if (result.compressed) {
          builtContext.length = 0;
          builtContext.push(result.context);
          console.log(`    ⚡ context ${result.originalLength}→${result.compressedLength} chars (~${result.tokensSaved} tokens saved, ${(result.similarityScore * 100).toFixed(0)}% similarity)`);
        }
      } catch {}
    }

    results.push(...batchResults);
  }

  await sandbox.teardown();
  return results;
}

async function executeTask(
  task: Task,
  graph: TaskGraph,
  ctx: ExecutionContext
): Promise<TaskResult> {
  const lang = ctx.language;
  const targetFile = task.targetFile ?? `src/index.${langToExt(lang)}`;
  const model = WORKER_MODEL[task.worker];

  // ── Read existing project files for context ───────────────────────────────
  const existingCode = await readExistingFiles(ctx.outputDir, graph, task);

  // ── Build the prompt ──────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(task.worker, lang);

  const fileMapSummary = graph.fileMap
    .map(f => `  ${f.path} — ${f.description} [exports: ${f.exports.join(", ") || "none"}]`)
    .join("\n");

  const priorSection = ctx.priorContext && ctx.priorContext.length > 50
    ? `\n--- PRIOR TASK OUTPUTS (for consistency) ---\n${ctx.priorContext.slice(0, 1200)}\n---\n`
    : "";

  const existingSection = existingCode.length > 0
    ? `\n--- EXISTING PROJECT FILES (import from these, do NOT redefine) ---\n${existingCode}\n---\n`
    : "";

  const retrySection = task.context.notes
    ? `\nPRIOR ATTEMPT FEEDBACK: ${task.context.notes}\n`
    : "";

  const prompt = `${systemPrompt}

PROJECT: ${ctx.projectName}
LANGUAGE: ${lang}

PROJECT FILE STRUCTURE (complete map — all files that will exist):
${fileMapSummary}

YOUR TASK: ${task.description}
YOUR OUTPUT FILE: ${targetFile}
${task.exports && task.exports.length > 0 ? `YOU MUST EXPORT: ${task.exports.join(", ")}` : ""}
${priorSection}${existingSection}${retrySection}
Write ONLY the content for ${targetFile}.
Do NOT redefine things already implemented in existing files — import them instead.
Output a single \`\`\`${lang.toLowerCase()}\`\`\` code block with the complete file content.`;

  console.log(`  → [${task.worker}] ${targetFile}`);

  // ── Generate ──────────────────────────────────────────────────────────────
  const raw = await generate(prompt, { model, temperature: 0.3, num_ctx: 12000 }, task.worker);
  let output = stripThinking(raw);

  // ── Self-review (code_gen only) ───────────────────────────────────────────
  if (task.worker === "code_gen" || task.worker === "test_runner") {
    output = await selfReview(output, task, lang, targetFile, existingCode);
  }

  // ── Write to specific file ────────────────────────────────────────────────
  await writeToTargetFile(output, targetFile, ctx.outputDir, lang, task.worker);

  const confidence = computeConfidence(output, task, lang);
  return { taskId: task.id, output, confidence, worker: task.worker };
}

// ─── Read existing project files ─────────────────────────────────────────────
// Before writing, see what's already been built. Import, don't reinvent.

async function readExistingFiles(
  outputDir: string,
  graph: TaskGraph,
  currentTask: Task
): Promise<string> {
  const sections: string[] = [];

  // Read files that completed tasks already wrote
  const completedTasks = graph.tasks.filter(
    (t) => t.status === "complete" && t.targetFile && t.id !== currentTask.id
  );

  for (const t of completedTasks) {
    if (!t.targetFile) continue;
    const filePath = join(outputDir, t.targetFile);
    if (!existsSync(filePath)) continue;

    try {
      const content = await readFile(filePath, "utf-8");
      // Include truncated version — enough to understand imports/exports
      const preview = content.length > 1500
        ? content.slice(0, 1500) + "\n// ... (truncated)"
        : content;
      sections.push(`// FILE: ${t.targetFile}\n${preview}`);
    } catch {}
  }

  return sections.join("\n\n");
}

// ─── Self-review ──────────────────────────────────────────────────────────────

async function selfReview(
  output: string,
  task: Task,
  lang: string,
  targetFile: string,
  existingCode: string
): Promise<string> {
  const existingSection = existingCode.length > 0
    ? `\nExisting code in project:\n${existingCode.slice(0, 1000)}\n`
    : "";

  const prompt = `You are a senior ${lang} engineer reviewing code before it ships.

File being reviewed: ${targetFile}
Task it solves: ${task.description}
${task.exports?.length ? `Must export: ${task.exports.join(", ")}` : ""}
${existingSection}
Code to review:
${output}

Check:
1. Does it ONLY implement what's assigned to this file? (no duplicating other files)
2. Does it properly import from existing files instead of redefining?
3. Does it export everything required?
4. Any bugs or missing error handling?

If it's correct (score 8+/10): respond exactly "LGTM"
If it needs fixes: respond with ONLY the corrected \`\`\`${lang.toLowerCase()}\`\`\` code block.`;

  const raw = await generate(prompt, { model: MODELS.reviewer, temperature: 0.1, num_ctx: 10000 }, "self_review");
  const critique = stripThinking(raw).trim();

  if (critique.startsWith("LGTM") || critique.length < 30) return output;

  const blocks = extractCodeBlocks(critique);
  if (blocks.length > 0) {
    console.log(`    ↻ self-reviewed`);
    return critique;
  }

  return output;
}

// ─── Assembly pass ────────────────────────────────────────────────────────────
// After all tasks complete:
// 1. Scan all source files for external imports
// 2. Map imports → npm package names + versions
// 3. Write correct package.json with real deps
// 4. Write tsconfig.json, README
// 5. Interface validation — catch signature mismatches between files

export async function assembleProject(
  graph: TaskGraph,
  ctx: ExecutionContext
): Promise<void> {
  console.log("  🔧 Assembly pass...");

  const lang = ctx.language;

  // ── Scan all source files for imports ─────────────────────────────────────
  const sourceFiles = await collectSourceFiles(ctx.outputDir);
  const externalDeps = await detectExternalDeps(sourceFiles, lang);

  if (externalDeps.dependencies && Object.keys(externalDeps.dependencies).length > 0) {
    console.log(`    📦 Detected deps: ${Object.keys(externalDeps.dependencies).join(", ")}`);
  }

  // ── Write package.json (always — with correct deps) ───────────────────────
  const pkgPath = join(ctx.outputDir, "package.json");
  const existingPkg = existsSync(pkgPath)
    ? JSON.parse(await readFile(pkgPath, "utf-8").catch(() => "{}"))
    : {};

  const name = ctx.projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const pkg = {
    name: existingPkg.name ?? name,
    version: existingPkg.version ?? "0.1.0",
    description: existingPkg.description ?? graph.goal,
    main: lang === "TypeScript" ? "dist/index.js" : "src/index.js",
    scripts: lang === "TypeScript"
      ? { build: "tsc", start: "bun src/index.ts", dev: "bun --watch src/index.ts", test: "bun test tests/", lint: "bunx biome check --apply src/", "type-check": "tsc --noEmit" }
      : { start: "bun src/index.js", test: "bun test tests/", lint: "bunx biome check --apply src/" },
    dependencies: {
      ...(externalDeps.dependencies ?? {}),
      ...(existingPkg.dependencies ?? {}),
    },
    devDependencies: {
      ...(lang === "TypeScript"
        ? { typescript: "^5.9.3", "@types/node": "^25.0.0", "@biomejs/biome": "^2.4.6" }
        : { "@biomejs/biome": "^2.4.6" }),
      ...(externalDeps.devDependencies ?? {}),
    },
  };

  await writeFile(pkgPath, JSON.stringify(pkg, null, 2), "utf-8");
  console.log("    ✓ package.json (with detected deps)");

  // ── tsconfig.json ─────────────────────────────────────────────────────────
  if (lang === "TypeScript") {
    const tsconfigPath = join(ctx.outputDir, "tsconfig.json");
    if (!existsSync(tsconfigPath)) {
      const tsconfig = {
        compilerOptions: {
          target: "ES2022", module: "CommonJS",
          moduleResolution: "node", outDir: "./dist",
          rootDir: "./src", strict: true, esModuleInterop: true,
          skipLibCheck: true, declaration: true,
        },
        include: ["src/**/*"],
        exclude: ["node_modules", "dist"],
      };
      await writeFile(tsconfigPath, JSON.stringify(tsconfig, null, 2), "utf-8");
      console.log("    ✓ tsconfig.json");
    }
  }

  // ── biome.json ────────────────────────────────────────────────────────────
  if (!existsSync(join(ctx.outputDir, "biome.json"))) {
    const biome = {
      $schema: "https://biomejs.dev/schemas/2.4.6/schema.json",
      organizeImports: { enabled: true },
      linter: { enabled: true, rules: { recommended: true } },
      formatter: { enabled: true, indentStyle: "space", indentWidth: 2, lineWidth: 100 },
      javascript: { formatter: { quoteStyle: "double", semicolons: "always" } },
    };
    await writeFile(join(ctx.outputDir, "biome.json"), JSON.stringify(biome, null, 2), "utf-8");
    console.log("    ✓ biome.json");
  }

  // ── README ────────────────────────────────────────────────────────────────
  if (!existsSync(join(ctx.outputDir, "README.md"))) {
    const depList = Object.keys(externalDeps.dependencies ?? {}).join(", ");
    const readme = [
      `# ${ctx.projectName}`,
      ``,
      `${graph.goal}`,
      ``,
      `## Setup`,
      ``,
      "```bash",
      "npm install",
      lang === "TypeScript" ? "npm run dev" : "npm start",
      "```",
      depList ? `\n## Dependencies\n\n${depList}` : "",
    ].join("\n");
    await writeFile(join(ctx.outputDir, "README.md"), readme, "utf-8");
    console.log("    ✓ README.md");
  }

  // ── Interface validation ───────────────────────────────────────────────────
  await validateInterfaces(sourceFiles, ctx.outputDir, lang);
}

// ─── Dependency detection ─────────────────────────────────────────────────────
// Read all source files, extract import statements, map to npm packages.

async function collectSourceFiles(outputDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const srcDir = join(outputDir, "src");
  if (!existsSync(srcDir)) return files;

  const entries = await readdir(srcDir).catch(() => [] as string[]);
  for (const entry of entries) {
    const fullPath = join(srcDir, entry);
    try {
      const content = await readFile(fullPath, "utf-8");
      files.set(`src/${entry}`, content);
    } catch {}
  }
  return files;
}

// Known npm package mappings: import name → { dep, devDep, types }
const KNOWN_PACKAGES: Record<string, { dep?: string; version?: string; types?: string }> = {
  "date-fns":    { dep: "date-fns", version: "^4.1.0" },
  "yargs":       { dep: "yargs", version: "^18.0.0", types: "@types/yargs" },
  "commander":   { dep: "commander", version: "^14.0.3" },
  "chalk":       { dep: "chalk", version: "^5.6.2" },
  "ora":         { dep: "ora", version: "^9.3.0" },
  "axios":       { dep: "axios", version: "^1.13.6" },
  "express":     { dep: "express", version: "^5.1.0", types: "@types/express" },
  "lodash":      { dep: "lodash", version: "^4.17.21", types: "@types/lodash" },
  "dotenv":      { dep: "dotenv", version: "^17.3.1" },
  "zod":         { dep: "zod", version: "^4.3.6" },
  "inquirer":    { dep: "inquirer", version: "^13.3.0" },
  "glob":        { dep: "glob", version: "^13.0.6" },
  "fs-extra":    { dep: "fs-extra", version: "^11.3.0", types: "@types/fs-extra" },
  "kleur":       { dep: "kleur", version: "^4.1.5" },
  "minimist":    { dep: "minimist", version: "^1.2.8", types: "@types/minimist" },
  "table":       { dep: "table", version: "^6.9.0" },
  "cli-table3":  { dep: "cli-table3", version: "^0.6.5", types: "@types/cli-table3" },
  "p-limit":     { dep: "p-limit", version: "^6.2.0" },
  "execa":       { dep: "execa", version: "^9.5.3" },
  "fast-glob":   { dep: "fast-glob", version: "^3.3.3" },
  "picocolors":  { dep: "picocolors", version: "^1.1.1" },
};

async function detectExternalDeps(
  files: Map<string, string>,
  lang: string
): Promise<{ dependencies: Record<string, string>; devDependencies: Record<string, string> }> {
  const deps: Record<string, string> = {};
  const devDeps: Record<string, string> = {};

  // Regex to match: import ... from 'pkg' and require('pkg')
  const importRegex = /(?:import\s+.*?from\s+['"]([^.][^'"]*?)['"]|require\(['"]([^.][^'"]*?)['"]\))/g;

  for (const [, content] of files) {
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const pkg = (match[1] ?? match[2]).split("/")[0]; // handle scoped: @types/node → @types
      if (!pkg || pkg.startsWith("@types")) continue;

      const known = KNOWN_PACKAGES[pkg];
      if (known?.dep) {
        deps[known.dep] = known.version ?? "latest";
        if (known.types && lang === "TypeScript") {
          devDeps[known.types] = "latest";
        }
      }
      // Unknown external package — add it with "latest" as a best guess
      else if (!pkg.startsWith(".") && !["fs", "path", "os", "crypto", "child_process", "stream", "util", "events", "http", "https", "url", "net", "assert"].includes(pkg)) {
        deps[pkg] = "latest";
      }
    }
  }

  return { dependencies: deps, devDependencies: devDeps };
}

// ─── Interface validation ─────────────────────────────────────────────────────
// Scan imports across files and auto-fix mismatches using qwen2.5-coder:14b.

async function validateInterfaces(
  files: Map<string, string>,
  outputDir: string,
  lang: string
): Promise<void> {
  // Build export map: filename → exported symbols
  const buildExportMap = (fileMap: Map<string, string>): Map<string, Set<string>> => {
    const exportMap = new Map<string, Set<string>>();
    for (const [filename, content] of fileMap) {
      const exports = new Set<string>();
      const exportRegex = /export\s+(?:function|const|class|interface|type|enum)\s+(\w+)/g;
      let m;
      while ((m = exportRegex.exec(content)) !== null) exports.add(m[1]);
      exportMap.set(filename, exports);
    }
    return exportMap;
  };

  // Find mismatches: returns list of {importer, symbol, sourceKey, sourcePath}
  const findMismatches = (
    fileMap: Map<string, string>,
    exportMap: Map<string, Set<string>>
  ): Array<{ importer: string; symbol: string; sourceKey: string; fromPath: string }> => {
    const mismatches: Array<{ importer: string; symbol: string; sourceKey: string; fromPath: string }> = [];
    for (const [filename, content] of fileMap) {
      const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"](\.[^'"]+)['"]/g;
      let m;
      while ((m = importRegex.exec(content)) !== null) {
        const importedSymbols = m[1].split(",").map(s => s.trim().split(" as ")[0].trim()).filter(Boolean);
        const fromPath = m[2];
        const resolvedKey = `src/${fromPath.replace(/^\.\//, "").replace(/\.ts$/, "")}.ts`;
        const availableExports = exportMap.get(resolvedKey);
        if (availableExports) {
          for (const sym of importedSymbols) {
            if (sym && !availableExports.has(sym)) {
              mismatches.push({ importer: filename, symbol: sym, sourceKey: resolvedKey, fromPath });
            }
          }
        }
      }
    }
    return mismatches;
  };

  let exportMap = buildExportMap(files);
  let mismatches = findMismatches(files, exportMap);

  if (mismatches.length === 0) {
    console.log("    ✓ Interface validation passed");
    return;
  }

  console.log(`    ⚠️  Interface validation: ${mismatches.length} mismatch(es) found — attempting auto-fix...`);

  // Group mismatches by source file so we patch each file once
  const bySourceFile = new Map<string, Array<{ importer: string; symbol: string }>>();
  for (const m of mismatches) {
    const existing = bySourceFile.get(m.sourceKey) ?? [];
    existing.push({ importer: m.importer, symbol: m.symbol });
    bySourceFile.set(m.sourceKey, existing);
  }

  for (const [sourceKey, issues] of bySourceFile) {
    const sourceContent = files.get(sourceKey);
    if (!sourceContent) {
      console.log(`    ✗ Cannot patch '${sourceKey}' — file not in map`);
      continue;
    }

    const symbols = [...new Set(issues.map(i => i.symbol))];
    const importers = [...new Set(issues.map(i => i.importer))];
    console.log(`    🔧 Patching '${sourceKey}' to export: ${symbols.join(", ")}`);

    const patchPrompt = `You are a ${lang} engineer fixing a missing export bug.

FILE TO PATCH: ${sourceKey}
MISSING EXPORTS: ${symbols.join(", ")}

These symbols are imported by: ${importers.join(", ")}
But they are not exported from the source file.

Current file content:
\`\`\`${lang.toLowerCase()}
${sourceContent}
\`\`\`

Your job:
1. If the symbol is already defined (function, const, class, type, interface, enum) but missing the 'export' keyword, add 'export' to its declaration.
2. If the symbol doesn't exist at all, add a minimal correct stub that exports it with the right shape based on its name and context.
3. Do NOT change any existing exports or logic — only ADD the missing exports.
4. Return ONLY the complete patched file in a single \`\`\`${lang.toLowerCase()}\`\`\` code block. No explanation.`;

    const raw = await generate(patchPrompt, { model: "qwen2.5-coder:14b", temperature: 0.1, num_ctx: 8000 }, "interface_fix");
    const patched = stripThinking(raw);

    // Extract code block
    const blocks: Array<{ lang: string; code: string }> = [];
    const blockRegex = /```([a-zA-Z0-9]*)\n([\s\S]*?)```/g;
    let bm;
    while ((bm = blockRegex.exec(patched)) !== null) {
      if (bm[2].trim().length > 10) blocks.push({ lang: bm[1] || "txt", code: bm[2].trim() });
    }

    if (blocks.length === 0) {
      console.log(`    ✗ Model returned no code block for '${sourceKey}' — skipping`);
      continue;
    }

    const patchedCode = blocks[0].code;
    const fullPath = join(outputDir, sourceKey);

    try {
      await writeFile(fullPath, patchedCode, "utf-8");
      files.set(sourceKey, patchedCode);
      console.log(`    ✓ Patched '${sourceKey}' (+exports: ${symbols.join(", ")})`);
    } catch (err) {
      console.log(`    ✗ Failed to write patched file '${sourceKey}': ${err}`);
    }
  }

  // Re-run validation to confirm fixes
  exportMap = buildExportMap(files);
  const remaining = findMismatches(files, exportMap);

  if (remaining.length === 0) {
    console.log("    ✓ Interface validation passed after patching");
  } else {
    console.log(`    ⚠️  ${remaining.length} mismatch(es) remain after patching:`);
    for (const m of remaining) {
      console.log(`       ${m.importer} imports '${m.symbol}' from '${m.fromPath}' — still not exported`);
    }
  }
}

// ─── File writing ─────────────────────────────────────────────────────────────

async function writeToTargetFile(
  output: string,
  targetFile: string,
  outputDir: string,
  lang: string,
  worker: WorkerType
): Promise<void> {
  const fullPath = join(outputDir, targetFile);
  await mkdir(dirname(fullPath), { recursive: true });

  // For JSON files (package.json etc), write raw
  if (targetFile.endsWith(".json")) {
    const jsonStr = (() => {
      const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenced) return fenced[1].trim();
      const s = output.indexOf("{"); const e = output.lastIndexOf("}");
      if (s !== -1 && e > s) return output.slice(s, e + 1);
      return output;
    })();
    try {
      await writeFile(fullPath, JSON.stringify(JSON.parse(jsonStr), null, 2), "utf-8");
    } catch {
      await writeFile(fullPath, output, "utf-8");
    }
    console.log(`    ✓ ${targetFile}`);
    return;
  }

  // For markdown
  if (targetFile.endsWith(".md")) {
    await writeFile(fullPath, output, "utf-8");
    console.log(`    ✓ ${targetFile}`);
    return;
  }

  // For code files — extract primary code block
  const blocks = extractCodeBlocks(output);
  if (blocks.length > 0) {
    await writeFile(fullPath, blocks[0].code, "utf-8");
  } else {
    await writeFile(fullPath, output, "utf-8");
  }
  console.log(`    ✓ ${targetFile}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildSystemPrompt(worker: WorkerType, lang: string): string {
  switch (worker) {
    case "code_gen":
      return `You are an expert ${lang} engineer. Write production-quality, working ${lang} code.
- Proper error handling on every function that can fail
- Clear, descriptive names — no magic values
- Import from other project files instead of redefining
- Export exactly the symbols listed`;

    case "test_runner":
      return `You are an expert ${lang} test engineer using Bun's test runner.
IMPORTANT: Tests are written BEFORE the implementation — write tests against the interface/types only, not a specific implementation.
- Import test utilities from "bun:test": import { describe, it, expect, beforeEach } from "bun:test"
- Import the actual functions from the source files using relative paths — don't reimplement them
- Write comprehensive tests: happy path, edge cases, and error conditions
- Each test has a descriptive name that reads like a sentence
- Use describe() blocks to group related tests
- Tests must actually run — no placeholder or TODO tests`;

    case "debugger":
      return `You are an expert ${lang} debugger.
- Find the root cause (one sentence)
- Write the minimal fix
- Don't change unrelated code`;

    case "doc_writer":
      return `You are a technical documentation writer.
- Start with what it does in one line
- Quick-start example first
- Document every exported function
- No fluff`;

    default:
      return `You are a ${lang} specialist. Complete the assigned task precisely.`;
  }
}

function extractCodeBlocks(text: string): Array<{ lang: string; code: string }> {
  const blocks: Array<{ lang: string; code: string }> = [];
  // Try closed blocks first (non-greedy)
  const closedRegex = /```([a-zA-Z0-9]*)\n([\s\S]*?)```/g;
  let match;
  while ((match = closedRegex.exec(text)) !== null) {
    if (match[2].trim().length > 10) {
      blocks.push({ lang: match[1] || "txt", code: match[2].trim() });
    }
  }
  if (blocks.length > 0) return blocks;

  // Fallback: model output was truncated before closing ```, grab everything after opening fence
  const openRegex = /```([a-zA-Z0-9]*)\n([\s\S]+)$/;
  const openMatch = text.match(openRegex);
  if (openMatch && openMatch[2].trim().length > 10) {
    blocks.push({ lang: openMatch[1] || "txt", code: openMatch[2].trim() });
  }
  return blocks;
}

function langToExt(lang: string): string {
  const map: Record<string, string> = {
    TypeScript: "ts", JavaScript: "js", Python: "py",
    Rust: "rs", Go: "go", Lua: "lua",
  };
  return map[lang] ?? "ts";
}

function computeConfidence(output: string, task: Task, lang: string): number {
  const len = output.length;
  let score = 0.45;

  if (len > 300) score += 0.1;
  if (len > 800) score += 0.1;
  if (output.includes("```")) score += 0.2;
  if (output.toLowerCase().includes("import")) score += 0.05; // using imports = good sign
  if (output.includes("↻")) score += 0.05;

  const refusals = ["i cannot", "i'm sorry", "as an ai", "i am unable"];
  if (refusals.some(s => output.toLowerCase().includes(s))) score -= 0.35;

  if (task.worker === "test_runner" && (output.includes("test(") || output.includes("it(") || output.includes("def test_"))) score += 0.1;
  if (task.exports?.some(exp => output.includes(`export`) && output.includes(exp))) score += 0.1;

  return Math.max(0, Math.min(1, score));
}
