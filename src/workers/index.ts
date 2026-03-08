// ─── Execution Pool ───────────────────────────────────────────────────────────
// Runs tasks from the task graph using specialized worker models.
// Independent tasks run in parallel. Results go to the evaluator.

import { generate } from "../ollama.js";
import { readyTasks } from "../planner/index.js";
import type { TaskGraph, Task, TaskResult, WorkerType } from "../types.js";

interface WorkerConfig {
  model: string;
  systemPrompt: string;
}

const WORKER_CONFIG: Record<WorkerType, WorkerConfig> = {
  code_gen: {
    model: "qwen3:14b",
    systemPrompt:
      "You are a code generation specialist. Write clean, working, well-structured code for the given task. Include comments for clarity.",
  },
  debugger: {
    model: "qwen3:8b",
    systemPrompt:
      "You are a debugging specialist. Identify errors and produce minimal, correct patches. Explain the root cause briefly.",
  },
  doc_writer: {
    model: "qwen3:8b",
    systemPrompt:
      "You are a documentation specialist. Write clear, concise documentation targeted at the intended audience.",
  },
  test_runner: {
    model: "qwen3:8b",
    systemPrompt:
      "You are a testing specialist. Write comprehensive tests covering edge cases. Focus on correctness and coverage.",
  },
  file_ops: {
    model: "qwen3:8b",
    systemPrompt:
      "You are a file operations specialist. Handle file system tasks precisely and safely.",
  },
};

export async function executeGraph(graph: TaskGraph): Promise<TaskResult[]> {
  const results: TaskResult[] = [];

  // Keep executing ready tasks until none remain
  while (true) {
    const ready = readyTasks(graph);
    if (ready.length === 0) break;

    // Run all ready tasks in parallel
    const batchResults = await Promise.all(
      ready.map(async (task) => {
        task.status = "running";
        try {
          const result = await executeTask(task);
          task.status = "complete";
          return result;
        } catch (err) {
          task.status = "failed";
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

async function executeTask(task: Task): Promise<TaskResult> {
  const config = WORKER_CONFIG[task.worker];
  const prompt = `${config.systemPrompt}

Task: ${task.description}
${task.context.notes ? `Context: ${task.context.notes}` : ""}`;

  console.log(`  → [${task.worker}] ${task.description}`);

  const output = await generate(prompt, {
    model: config.model,
    temperature: 0.6,
    num_ctx: 4096,
  });

  const confidence = computeConfidence(output, task.description);

  return {
    taskId: task.id,
    output,
    confidence,
    worker: task.worker,
  };
}

function computeConfidence(output: string, taskDescription: string): number {
  // v1: heuristic confidence. v2: use critic model
  const len = output.length;
  let score = 0.5;

  if (len > 200) score += 0.15;
  if (len > 500) score += 0.1;
  if (len > 50 && len < 10000) score += 0.1;

  // Penalize if output looks like a refusal or error
  const refusalSignals = ["i cannot", "i'm sorry", "i don't", "as an ai", "i am unable"];
  if (refusalSignals.some((s) => output.toLowerCase().includes(s))) {
    score -= 0.3;
  }

  // Bonus if output contains code
  if (output.includes("```") || output.includes("function") || output.includes("const ")) {
    score += 0.1;
  }

  return Math.max(0, Math.min(1, score));
}
