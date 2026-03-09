// ─── Planner ──────────────────────────────────────────────────────────────────
// Converts a vision + extracted goals into an ordered task graph.
// Tasks have explicit dependencies. Independent tasks run in parallel.

import { generate, stripThinking, parseJsonSafe } from "../ollama.js";
import type { VisionObject, Task, TaskGraph, WorkerType } from "../types.js";
import type { ExtractedGoal } from "../goals/index.js";
import { randomUUID } from "crypto";

export function createTaskGraph(goal: string): TaskGraph {
  return { goal, tasks: [] };
}

export function addTask(
  graph: TaskGraph,
  description: string,
  worker: WorkerType,
  dependsOn: string[] = []
): string {
  const id = randomUUID();
  graph.tasks.push({
    id,
    description,
    worker,
    dependsOn,
    context: { files: [], notes: "" },
    status: "pending",
  });
  return id;
}

export function readyTasks(graph: TaskGraph): Task[] {
  const completedIds = new Set(
    graph.tasks.filter((t) => t.status === "complete").map((t) => t.id)
  );
  return graph.tasks.filter(
    (t) =>
      t.status === "pending" &&
      t.dependsOn.every((dep) => completedIds.has(dep))
  );
}

export async function buildPlan(
  vision: VisionObject,
  goals: ExtractedGoal[] = []
): Promise<TaskGraph> {
  const goalsSection =
    goals.length > 0
      ? `\nUser-centered goals to address (derived from persona simulations):\n${goals
          .slice(0, 6)
          .map((g) => `- ${g.description} [impact: ${g.impactScore.toFixed(2)}]`)
          .join("\n")}\n`
      : "";

  const prompt = `You are a software project planner. Create a concrete, ordered task list to implement this product.

Product: ${vision.name}
Description: ${vision.description}
Components: ${vision.components.join(", ")}
UX Flow: ${vision.uxFlow.join(" → ")}
${goalsSection}
Rules:
- Break into 4-8 specific, implementable tasks
- Each task should be executable by a single worker
- Include setup/scaffold, core implementation, testing, and documentation
- Specify real dependencies (don't make everything depend on everything)

Workers available: code_gen, debugger, doc_writer, test_runner

Respond ONLY with a JSON array:
[
  {"description": "scaffold project structure and entry point", "worker": "code_gen", "dependsOn": []},
  {"description": "implement core feature X with error handling", "worker": "code_gen", "dependsOn": [0]},
  {"description": "write unit tests for feature X", "worker": "test_runner", "dependsOn": [1]},
  {"description": "write README and usage docs", "worker": "doc_writer", "dependsOn": [1]}
]`;

  const raw = await generate(prompt, { model: "qwen3:14b", temperature: 0.4 });
  const cleaned = stripThinking(raw);

  type RawTask = { description: string; worker: string; dependsOn: number[] };
  const rawTasks = parseJsonSafe<RawTask[]>(cleaned, []);

  const graph = createTaskGraph(vision.name);
  const taskIds: string[] = [];

  for (const rawTask of rawTasks) {
    const worker = validateWorker(rawTask.worker);
    const dependsOn = (rawTask.dependsOn ?? [])
      .map((i) => taskIds[i])
      .filter(Boolean) as string[];

    const id = addTask(graph, rawTask.description ?? "unnamed task", worker, dependsOn);
    taskIds.push(id);
  }

  if (graph.tasks.length === 0) {
    addTask(graph, `Analyze and scaffold: ${vision.name}`, "code_gen");
  }

  return graph;
}

function validateWorker(worker: string): WorkerType {
  const valid: WorkerType[] = ["code_gen", "debugger", "doc_writer", "test_runner", "file_ops"];
  return valid.includes(worker as WorkerType) ? (worker as WorkerType) : "code_gen";
}
