// ─── Planner ──────────────────────────────────────────────────────────────────
// Converts a vision into an ordered task graph with worker assignments.
// Tasks have explicit dependencies. Independent tasks can run in parallel.

import { generate, parseJsonSafe } from "../ollama.js";
import type { VisionObject, Task, TaskGraph, WorkerType } from "../types.js";
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

export async function buildPlan(vision: VisionObject): Promise<TaskGraph> {
  const prompt = `You are a software project planner. Create an ordered task list for this product.

Product: ${vision.name}
Description: ${vision.description}
Components: ${vision.components.join(", ")}
UX Flow: ${vision.uxFlow.join(" → ")}

Create concrete development tasks. Each task:
- description: what to implement (be specific)
- worker: one of [code_gen, debugger, doc_writer, test_runner]
- dependsOn: array of 0-based indices of tasks this depends on

Respond ONLY with a JSON array:
[
  {"description": "scaffold project structure", "worker": "code_gen", "dependsOn": []},
  {"description": "implement core feature X", "worker": "code_gen", "dependsOn": [0]},
  {"description": "write unit tests for X", "worker": "test_runner", "dependsOn": [1]},
  {"description": "write documentation", "worker": "doc_writer", "dependsOn": [2]}
]`;

  const raw = await generate(prompt, { model: "mistral:7b", temperature: 0.5 });

  type RawTask = { description: string; worker: string; dependsOn: number[] };
  const rawTasks = parseJsonSafe<RawTask[]>(raw, []);

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

  // Fallback: if parsing failed entirely
  if (graph.tasks.length === 0) {
    addTask(graph, `Analyze and scaffold: ${vision.name}`, "code_gen");
  }

  return graph;
}

function validateWorker(worker: string): WorkerType {
  const valid: WorkerType[] = ["code_gen", "debugger", "doc_writer", "test_runner", "file_ops"];
  return valid.includes(worker as WorkerType) ? (worker as WorkerType) : "code_gen";
}
