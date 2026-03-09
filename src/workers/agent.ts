// ─── Agentic Worker ───────────────────────────────────────────────────────────
// Workers are no longer one-shot generators. They get a multi-turn loop:
//   1. Generate initial code
//   2. Run it in the sandbox (type-check, execute, test)
//   3. Observe the real output / errors
//   4. Fix and re-run
//   5. Accept when it actually passes
//
// This is the sandboxed shell integration — workers see real execution feedback.

import { generate, stripThinking } from "../ollama.js";
import { Sandbox, formatToolResult, extractErrors } from "../sandbox/index.js";
import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import type { Task, WorkerType } from "../types.js";

const MAX_AGENT_TURNS = 4;
const MODELS = {
  coder: "qwen2.5-coder:14b",
  reviewer: "qwen3:14b",
  light: "qwen3:8b",
} as const;

const WORKER_MODEL: Record<WorkerType, string> = {
  code_gen: MODELS.coder,
  test_runner: MODELS.coder,
  debugger: MODELS.coder,
  doc_writer: MODELS.light,
  file_ops: MODELS.light,
};

export interface AgentResult {
  output: string;
  confidence: number;
  turns: number;
  toolsUsed: string[];
  finallyPassed: boolean;
}

export async function runAgenticWorker(
  task: Task,
  sandbox: Sandbox,
  fileMapSummary: string,
  priorContext: string,
  existingCode: string
): Promise<AgentResult> {
  const lang = sandbox.language;
  const targetFile = task.targetFile ?? `src/index.${langToExt(lang)}`;
  const model = WORKER_MODEL[task.worker];
  const toolsUsed: string[] = [];
  let turns = 0;
  let lastOutput = "";
  let conversationHistory = "";

  // ── System prompt ─────────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(task.worker, lang);

  // ── Initial context ───────────────────────────────────────────────────────
  const priorSection = priorContext.length > 50
    ? `\nPRIOR TASK OUTPUTS:\n${priorContext.slice(0, 1000)}\n`
    : "";
  const existingSection = existingCode.length > 50
    ? `\nEXISTING FILES (import from these):\n${existingCode.slice(0, 1500)}\n`
    : "";

  const basePrompt = `${systemPrompt}

PROJECT: ${sandbox.projectDir.split("/").pop()}
LANGUAGE: ${lang}
FILE MAP:\n${fileMapSummary}
YOUR FILE: ${targetFile}
${task.exports?.length ? `MUST EXPORT: ${task.exports.join(", ")}` : ""}
TASK: ${task.description}
${priorSection}${existingSection}
Write the complete content of ${targetFile}.
Output a single \`\`\`${lang.toLowerCase()}\`\`\` code block.`;

  // ── Agentic loop ──────────────────────────────────────────────────────────
  while (turns < MAX_AGENT_TURNS) {
    turns++;

    const prompt = turns === 1
      ? basePrompt
      : `${basePrompt}\n\n${conversationHistory}\n\nFix the issues above and output the corrected \`\`\`${lang.toLowerCase()}\`\`\` code block.`;

    const raw = await generate(prompt, { model, temperature: 0.3, num_ctx: 12000 });
    const output = stripThinking(raw);

    // Extract and write code to sandbox
    const code = extractPrimaryCode(output);
    if (code) {
      await sandbox.writeFile(targetFile, code);
      lastOutput = output;
    } else {
      // No code block — probably just text, keep going
      conversationHistory += `\nTurn ${turns}: No code block found in response.\n`;
      continue;
    }

    // ── Run tools based on worker type ─────────────────────────────────────
    const toolResults: string[] = [];

    if (task.worker === "code_gen" || task.worker === "debugger") {
      // Type-check the file
      if (lang === "TypeScript" && await sandbox.checkFileExists("tsconfig.json")) {
        const typeResult = await sandbox.typeCheck();
        toolResults.push(formatToolResult("tsc", typeResult));
        toolsUsed.push("tsc");

        if (typeResult.success) {
          console.log(`    ✓ types OK (turn ${turns})`);
          break; // Type-checked cleanly — done
        } else {
          const errors = extractErrors(typeResult);
          console.log(`    ⚠️  type errors (turn ${turns}): ${errors.length} issues`);
          conversationHistory += `\nTurn ${turns} type errors:\n${typeResult.stderr.slice(0, 800)}\n`;
          continue;
        }
      } else {
        // No tsconfig yet — just accept the output
        break;
      }
    }

    if (task.worker === "test_runner") {
      // Run the tests right now
      const testResult = await sandbox.runTests(targetFile);
      toolResults.push(formatToolResult("bun test", testResult));
      toolsUsed.push("bun test");

      if (testResult.success) {
        console.log(`    ✓ tests pass (turn ${turns})`);
        break;
      } else {
        const errors = extractErrors(testResult);
        console.log(`    ⚠️  test failures (turn ${turns}): ${errors.slice(0,2).join(" | ")}`);
        conversationHistory += `\nTurn ${turns} test output:\n${[testResult.stdout, testResult.stderr].join("\n").slice(0, 800)}\n`;
        continue;
      }
    }

    // doc_writer, file_ops — no tools needed, one shot
    break;
  }

  const finallyPassed = turns < MAX_AGENT_TURNS || conversationHistory.length === 0;
  const confidence = computeConfidence(lastOutput, task, finallyPassed, turns);

  return { output: lastOutput, confidence, turns, toolsUsed, finallyPassed };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildSystemPrompt(worker: WorkerType, lang: string): string {
  switch (worker) {
    case "code_gen":
      return `You are an expert ${lang} engineer with access to a live sandbox.
Write production code. After you write it, it will be type-checked in real-time.
If there are errors, you'll see them and fix them. Be precise with types and imports.`;

    case "test_runner":
      return `You are an expert ${lang} test engineer using Bun's test runner.
Import from "bun:test": import { describe, it, expect } from "bun:test"
Import source functions from relative paths. Your tests will actually run — write ones that pass.`;

    case "debugger":
      return `You are an expert ${lang} debugger.
Identify the root cause. Write the minimal fix. Your patch will be type-checked immediately.`;

    case "doc_writer":
      return `You are a technical documentation expert. Quick-start example first. No fluff.`;

    default:
      return `You are a ${lang} specialist. Complete the task precisely.`;
  }
}

function extractPrimaryCode(text: string): string | null {
  const regex = /```[a-zA-Z0-9]*\n([\s\S]*?)```/;
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}

function computeConfidence(
  output: string,
  task: Task,
  passed: boolean,
  turns: number
): number {
  let score = passed ? 0.75 : 0.4;
  if (output.includes("```")) score += 0.1;
  if (output.toLowerCase().includes("import")) score += 0.05;
  if (turns === 1 && passed) score += 0.1; // got it right first try
  if (task.worker === "test_runner" && passed) score += 0.1;
  const refusals = ["i cannot", "i'm sorry", "as an ai"];
  if (refusals.some((s) => output.toLowerCase().includes(s))) score -= 0.4;
  return Math.max(0, Math.min(1, score));
}

function langToExt(lang: string): string {
  const map: Record<string, string> = {
    TypeScript: "ts", JavaScript: "js", Python: "py",
    Rust: "rs", Go: "go", Lua: "lua",
  };
  return map[lang] ?? "ts";
}

// Re-export writeFile convenience for callers
export { writeFile, mkdir };
