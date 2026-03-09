// ─── Execution Pool ───────────────────────────────────────────────────────────
// Workers execute tasks with:
// - Context carry-forward (see what prior tasks built)
// - Multi-turn refinement (self-critique + improve before accepting)
// - Code review pass (separate reviewer catches issues)
// - Language locking (consistent language across all tasks)
// - Actual file output

import { generate, stripThinking } from "../ollama.js";
import { readyTasks } from "../planner/index.js";
import type { TaskGraph, Task, TaskResult, WorkerType } from "../types.js";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

export interface ExecutionContext {
  outputDir: string;
  projectName: string;
  language?: string;          // lock all code to this language
  priorOutputs?: string[];    // context carry-forward
}

interface WorkerConfig {
  model: string;
  systemPrompt: (lang: string) => string;
}

const WORKER_CONFIG: Record<WorkerType, WorkerConfig> = {
  code_gen: {
    model: "qwen2.5-coder:14b",
    systemPrompt: (lang) => `You are an expert ${lang} engineer. Write production-quality, working code.

Rules:
- Use ${lang} exclusively. No other languages.
- Every function needs error handling.
- Use clear variable names — no single letters except loop counters.
- Include a brief comment above each function explaining what it does.
- Output ONLY a single \`\`\`${lang.toLowerCase()}\`\`\` code block. Nothing else — no explanation before or after.`,
  },
  debugger: {
    model: "qwen3:14b",
    systemPrompt: (lang) => `You are an expert ${lang} debugger. Find and fix bugs with surgical precision.

Rules:
- Identify the root cause first (one sentence).
- Output the minimal patch that fixes the issue.
- Explain what was wrong and why the fix works (2-3 sentences max).
- Use a \`\`\`${lang.toLowerCase()}\`\`\` code block for the fix.`,
  },
  doc_writer: {
    model: "qwen3:8b",
    systemPrompt: (_lang) => `You are a technical documentation expert. Write clear, useful docs.

Rules:
- Start with a one-line description of what the thing does.
- Include a quick-start example first — users learn from examples.
- Document every public function/method.
- Use markdown. Include a table of contents if more than 3 sections.
- No fluff. No "This document describes...". Just get to the point.`,
  },
  test_runner: {
    model: "qwen3:8b",
    systemPrompt: (lang) => `You are an expert ${lang} test engineer. Write comprehensive tests.

Rules:
- Test the happy path, edge cases, and error conditions.
- Each test should have a descriptive name explaining what it's testing.
- Tests must be runnable — use the standard test framework for ${lang}.
- Output ONLY a \`\`\`${lang.toLowerCase()}\`\`\` code block with the complete test file.`,
  },
  file_ops: {
    model: "qwen3:8b",
    systemPrompt: (_lang) => `You are a file system specialist. Handle file operations safely and precisely.`,
  },
};

export async function executeGraph(
  graph: TaskGraph,
  ctx: ExecutionContext
): Promise<TaskResult[]> {
  await mkdir(ctx.outputDir, { recursive: true });

  const results: TaskResult[] = [];
  const builtContext: string[] = []; // accumulates as tasks complete

  while (true) {
    const ready = readyTasks(graph);
    if (ready.length === 0) break;

    // Run ready tasks in parallel (each gets current builtContext snapshot)
    const contextSnapshot = [...builtContext];
    const batchResults = await Promise.all(
      ready.map(async (task) => {
        task.status = "running";
        try {
          const result = await executeTask(task, { ...ctx, priorOutputs: contextSnapshot });
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

    // Add completed outputs to carry-forward context
    for (const r of batchResults) {
      if (r.confidence > 0.5 && r.output.length > 100) {
        builtContext.push(
          `[${r.worker} completed: "${graph.tasks.find(t => t.id === r.taskId)?.description ?? "task"}"]\n${r.output.slice(0, 800)}`
        );
      }
    }

    results.push(...batchResults);
  }

  return results;
}

async function executeTask(task: Task, ctx: ExecutionContext): Promise<TaskResult> {
  const lang = ctx.language ?? "TypeScript";
  const config = WORKER_CONFIG[task.worker];
  const systemPrompt = config.systemPrompt(lang);

  // Build context section from prior work
  const contextSection = ctx.priorOutputs && ctx.priorOutputs.length > 0
    ? `\n---\nCONTEXT FROM PRIOR TASKS (use this for consistency):\n${ctx.priorOutputs.slice(-3).join("\n\n")}\n---\n`
    : "";

  // Additional context from task-level notes (retry context)
  const taskContext = task.context.notes
    ? `\nADDITIONAL CONTEXT:\n${task.context.notes}\n`
    : "";

  const prompt = `${systemPrompt}
${contextSection}${taskContext}
PROJECT: ${ctx.projectName}
TASK: ${task.description}`;

  console.log(`  → [${task.worker}] ${task.description}`);

  // Step 1: Initial generation
  const rawOutput = await generate(prompt, {
    model: config.model,
    temperature: 0.4,
    num_ctx: 8192,
  });
  let output = stripThinking(rawOutput);

  // Step 2: Self-critique + refinement (code_gen only — highest impact)
  if (task.worker === "code_gen") {
    output = await refineCode(output, task.description, lang, config.model);
  }

  // Step 3: Write to disk
  await persistOutput(task, output, ctx);

  const confidence = computeConfidence(output, task.description, task.worker);
  return { taskId: task.id, output, confidence, worker: task.worker };
}

// ─── Self-critique + refinement ──────────────────────────────────────────────
// The model reads its own output and improves it before we accept.
// This is the single biggest quality lever without changing model size.

async function refineCode(
  code: string,
  taskDescription: string,
  lang: string,
  model: string
): Promise<string> {
  const critiquePrompt = `You are a senior ${lang} code reviewer. Review this code critically.

Task it was supposed to solve: ${taskDescription}

Code to review:
${code}

Identify issues with:
1. Correctness — does it actually solve the task?
2. Error handling — are edge cases covered?
3. Code quality — clean, readable, maintainable?
4. Completeness — is anything missing?

If the code is good (8+/10), respond with exactly: LGTM
If it needs improvement, respond with ONLY the improved \`\`\`${lang.toLowerCase()}\`\`\` code block. No explanation.`;

  const rawCritique = await generate(critiquePrompt, {
    model,
    temperature: 0.2,
    num_ctx: 8192,
  });
  const critique = stripThinking(rawCritique).trim();

  if (critique.startsWith("LGTM") || critique.length < 50) {
    // Code was good, keep original
    return code;
  }

  // Extract improved code from critique response
  const blocks = extractCodeBlocks(critique);
  if (blocks.length > 0) {
    console.log(`    ↻ refined by self-review`);
    return critique; // return the full response with improved code
  }

  return code; // couldn't parse improvement, keep original
}

// ─── File output ─────────────────────────────────────────────────────────────

async function persistOutput(
  task: Task,
  output: string,
  ctx: ExecutionContext
): Promise<void> {
  const lang = ctx.language ?? "TypeScript";
  const slug = task.description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");

  if (task.worker === "code_gen" || task.worker === "test_runner" || task.worker === "debugger") {
    const blocks = extractCodeBlocks(output);
    if (blocks.length > 0) {
      // Only write the first/primary code block (avoid noise)
      const primaryBlock = blocks[0];
      const ext = langToExt(primaryBlock.lang || lang);
      const filename = `${slug}.${ext}`;
      await writeFile(join(ctx.outputDir, filename), primaryBlock.code, "utf-8");
      console.log(`    ✓ ${filename}`);
    } else {
      // No code block — write raw
      const ext = langToExt(lang);
      await writeFile(join(ctx.outputDir, `${slug}.${ext}`), output, "utf-8");
      console.log(`    ✓ ${slug}.${ext} (raw)`);
    }
  } else if (task.worker === "doc_writer") {
    await writeFile(join(ctx.outputDir, `${slug}.md`), output, "utf-8");
    console.log(`    ✓ ${slug}.md`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
    typescript: "ts", ts: "ts",
    javascript: "js", js: "js",
    python: "py", py: "py",
    rust: "rs", go: "go", lua: "lua",
    bash: "sh", sh: "sh",
    json: "json", yaml: "yaml", yml: "yaml",
    markdown: "md", md: "md",
    css: "css", html: "html",
  };
  return map[lang.toLowerCase()] ?? "ts";
}

function computeConfidence(output: string, taskDescription: string, worker: WorkerType): number {
  const len = output.length;
  let score = 0.45;

  if (len > 300) score += 0.1;
  if (len > 800) score += 0.1;
  if (len > 100 && len < 20000) score += 0.05;

  const refusalSignals = ["i cannot", "i'm sorry", "i don't", "as an ai", "i am unable", "i apologize"];
  if (refusalSignals.some((s) => output.toLowerCase().includes(s))) score -= 0.35;

  if (output.includes("```")) score += 0.2;
  if (output.includes("↻ refined")) score += 0.05; // was self-reviewed

  // Keyword alignment
  const taskWords = taskDescription.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const hits = taskWords.filter((w) => output.toLowerCase().includes(w)).length;
  score += Math.min(0.15, (hits / Math.max(taskWords.length, 1)) * 0.2);

  // Worker-specific bonuses
  if (worker === "test_runner" && output.includes("test(")) score += 0.1;
  if (worker === "doc_writer" && output.includes("##")) score += 0.1;

  return Math.max(0, Math.min(1, score));
}
