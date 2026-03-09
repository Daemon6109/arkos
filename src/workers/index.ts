// ─── Execution Pool ───────────────────────────────────────────────────────────
// Workers know which file they own. They read the project before writing.
// No more reinventing the wheel — each worker builds on what exists.

import { generate, stripThinking } from "../ollama.js";
import { readyTasks } from "../planner/index.js";
import type { TaskGraph, Task, TaskResult, WorkerType } from "../types.js";
import { mkdir, writeFile, readFile, readdir } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";

export interface ExecutionContext {
  outputDir: string;
  projectName: string;
  language: string;
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

export async function executeGraph(
  graph: TaskGraph,
  ctx: ExecutionContext
): Promise<TaskResult[]> {
  await mkdir(ctx.outputDir, { recursive: true });

  // Write the file map as a reference for workers
  await writeFile(
    join(ctx.outputDir, ".arkos-filemap.json"),
    JSON.stringify(graph.fileMap, null, 2),
    "utf-8"
  );

  const results: TaskResult[] = [];

  while (true) {
    const ready = readyTasks(graph);
    if (ready.length === 0) break;

    const batchResults = await Promise.all(
      ready.map(async (task) => {
        task.status = "running";
        try {
          const result = await executeTask(task, graph, ctx);
          task.status = "complete";
          return result;
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

    results.push(...batchResults);
  }

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
${existingSection}${retrySection}
Write ONLY the content for ${targetFile}.
Do NOT redefine things already implemented in existing files — import them instead.
Output a single \`\`\`${lang.toLowerCase()}\`\`\` code block with the complete file content.`;

  console.log(`  → [${task.worker}] ${targetFile}`);

  // ── Generate ──────────────────────────────────────────────────────────────
  const raw = await generate(prompt, { model, temperature: 0.3, num_ctx: 12000 });
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

  const raw = await generate(prompt, { model: MODELS.reviewer, temperature: 0.1, num_ctx: 10000 });
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
        ? { typescript: "^5.4.0", "@types/node": "^20.0.0", "@biomejs/biome": "^1.8.0" }
        : { "@biomejs/biome": "^1.8.0" }),
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
      $schema: "https://biomejs.dev/schemas/1.8.0/schema.json",
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
  "date-fns":    { dep: "date-fns", version: "^3.6.0" },
  "yargs":       { dep: "yargs", version: "^17.7.2", types: "@types/yargs" },
  "commander":   { dep: "commander", version: "^12.0.0" },
  "chalk":       { dep: "chalk", version: "^5.3.0" },
  "ora":         { dep: "ora", version: "^8.0.1" },
  "axios":       { dep: "axios", version: "^1.7.0" },
  "express":     { dep: "express", version: "^4.19.0", types: "@types/express" },
  "lodash":      { dep: "lodash", version: "^4.17.21", types: "@types/lodash" },
  "dotenv":      { dep: "dotenv", version: "^16.4.0" },
  "zod":         { dep: "zod", version: "^3.23.0" },
  "inquirer":    { dep: "inquirer", version: "^10.0.0", types: "@types/inquirer" },
  "glob":        { dep: "glob", version: "^11.0.0" },
  "fs-extra":    { dep: "fs-extra", version: "^11.2.0", types: "@types/fs-extra" },
  "kleur":       { dep: "kleur", version: "^4.1.5" },
  "minimist":    { dep: "minimist", version: "^1.2.8", types: "@types/minimist" },
  "table":       { dep: "table", version: "^6.8.2" },
  "cli-table3":  { dep: "cli-table3", version: "^0.6.5", types: "@types/cli-table3" },
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
// Scan imports across files and warn about obvious mismatches.

async function validateInterfaces(
  files: Map<string, string>,
  outputDir: string,
  lang: string
): Promise<void> {
  const issues: string[] = [];

  // Build export map: filename → exported symbols
  const exportMap = new Map<string, Set<string>>();
  for (const [filename, content] of files) {
    const exports = new Set<string>();
    const exportRegex = /export\s+(?:function|const|class|interface|type|enum)\s+(\w+)/g;
    let m;
    while ((m = exportRegex.exec(content)) !== null) exports.add(m[1]);
    exportMap.set(filename, exports);
  }

  // Check imports against export map
  for (const [filename, content] of files) {
    const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"](\.[^'"]+)['"]/g;
    let m;
    while ((m = importRegex.exec(content)) !== null) {
      const importedSymbols = m[1].split(",").map(s => s.trim().split(" as ")[0].trim());
      const fromPath = m[2];

      // Resolve relative path to a key in our file map
      const resolvedKey = `src/${fromPath.replace(/^\.\//, "").replace(/\.ts$/, "")}.ts`;
      const availableExports = exportMap.get(resolvedKey);

      if (availableExports) {
        for (const sym of importedSymbols) {
          if (!availableExports.has(sym)) {
            issues.push(`  ⚠️  ${filename} imports '${sym}' from '${fromPath}' but it's not exported there`);
          }
        }
      }
    }
  }

  if (issues.length > 0) {
    console.log("    Interface validation issues found:");
    issues.forEach(i => console.log(i));
  } else {
    console.log("    ✓ Interface validation passed");
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
  const regex = /```([a-zA-Z0-9]*)\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[2].trim().length > 10) {
      blocks.push({ lang: match[1] || "txt", code: match[2].trim() });
    }
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
