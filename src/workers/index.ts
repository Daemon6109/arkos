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
// After all tasks complete, write package.json + tsconfig if missing,
// and verify the entry point imports everything correctly.

export async function assembleProject(
  graph: TaskGraph,
  ctx: ExecutionContext
): Promise<void> {
  console.log("  🔧 Assembly pass...");

  const lang = ctx.language;

  // Write package.json if not already written by a task
  const hasPackageJson = existsSync(join(ctx.outputDir, "package.json"));
  if (!hasPackageJson) {
    const name = ctx.projectName.toLowerCase().replace(/\s+/g, "-");
    const pkg = {
      name,
      version: "0.1.0",
      description: graph.goal,
      scripts: lang === "TypeScript"
        ? { build: "tsc", start: "node dist/index.js", dev: "tsx src/index.ts" }
        : { start: "node src/index.js" },
      dependencies: {},
      devDependencies: lang === "TypeScript"
        ? { typescript: "^5.4.0", tsx: "^4.7.0", "@types/node": "^20.0.0" }
        : {},
    };
    await writeFile(join(ctx.outputDir, "package.json"), JSON.stringify(pkg, null, 2), "utf-8");
    console.log("    ✓ package.json");
  }

  // Write tsconfig.json for TypeScript projects
  if (lang === "TypeScript") {
    const hasTsConfig = existsSync(join(ctx.outputDir, "tsconfig.json"));
    if (!hasTsConfig) {
      const tsconfig = {
        compilerOptions: {
          target: "ES2022", module: "CommonJS",
          moduleResolution: "node", outDir: "./dist",
          rootDir: "./src", strict: true, esModuleInterop: true,
          skipLibCheck: true, declaration: true,
        },
        include: ["src/**/*"],
        exclude: ["node_modules", "dist", "tests"],
      };
      await writeFile(join(ctx.outputDir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2), "utf-8");
      console.log("    ✓ tsconfig.json");
    }
  }

  // Write a README stub if none exists
  const hasReadme = existsSync(join(ctx.outputDir, "README.md"));
  if (!hasReadme) {
    const readme = `# ${ctx.projectName}\n\n${graph.goal}\n\n## Setup\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`;
    await writeFile(join(ctx.outputDir, "README.md"), readme, "utf-8");
    console.log("    ✓ README.md");
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
      return `You are an expert ${lang} test engineer.
- Write comprehensive tests: happy path, edge cases, error conditions
- Use the standard test framework (Jest for TS/JS, pytest for Python)
- Import the actual functions from the source files — don't reimplement them
- Each test has a descriptive name`;

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
