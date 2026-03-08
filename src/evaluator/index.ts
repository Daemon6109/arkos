// ─── Evaluator / Critic ───────────────────────────────────────────────────────
// Multi-dimensional structured scoring. NOT binary like/dislike.
// Triggers adaptive context escalation when confidence is below threshold.

import type { TaskResult, TaskGraph, TaskEvaluation, RunEvaluation, EvalAction } from "../types.js";

export const CONFIDENCE_THRESHOLD = 0.65;
export const MAX_RETRIES = 3;

export async function evaluate(
  results: TaskResult[],
  graph: TaskGraph
): Promise<RunEvaluation> {
  const taskEvaluations: TaskEvaluation[] = [];

  for (const result of results) {
    const task = graph.tasks.find((t) => t.id === result.taskId);
    const eval_ = evaluateTask(result, task?.description ?? "");
    taskEvaluations.push(eval_);
  }

  const overallScore =
    taskEvaluations.length === 0
      ? 0
      : taskEvaluations.reduce((sum, e) => sum + e.overall, 0) / taskEvaluations.length;

  const passed = overallScore >= CONFIDENCE_THRESHOLD;
  const acceptedCount = taskEvaluations.filter((e) => e.action === "accept").length;

  return {
    taskEvaluations,
    overallScore,
    passed,
    summary: `${taskEvaluations.length} tasks evaluated. ${acceptedCount} accepted. Score: ${overallScore.toFixed(2)}`,
  };
}

function evaluateTask(result: TaskResult, taskDescription: string): TaskEvaluation {
  // v1: structured heuristics. v2: use dedicated critic model.
  const correctness = result.confidence;
  const goalAlignment = scoreGoalAlignment(result.output, taskDescription);
  const efficiency = scoreEfficiency(result.output);
  const uxImpact = 0.7; // placeholder — v2 derives from persona simulation

  const overall = (correctness + goalAlignment + efficiency + uxImpact) / 4;
  const action = determineAction(overall);

  return {
    taskId: result.taskId,
    correctness,
    goalAlignment,
    efficiency,
    uxImpact,
    overall,
    action,
    notes: `worker: ${result.worker}, output_len: ${result.output.length}`,
  };
}

function scoreGoalAlignment(output: string, taskDescription: string): number {
  // Naive keyword overlap — v2 uses embedding cosine similarity
  const taskWords = new Set(
    taskDescription.toLowerCase().split(/\W+/).filter((w) => w.length > 3)
  );
  const outputLower = output.toLowerCase();
  let matches = 0;
  for (const word of taskWords) {
    if (outputLower.includes(word)) matches++;
  }
  const ratio = taskWords.size > 0 ? matches / taskWords.size : 0;
  return Math.min(1, ratio * 1.5); // scale up
}

function scoreEfficiency(output: string): number {
  const len = output.length;
  if (len < 30) return 0.2;
  if (len < 100) return 0.5;
  if (len <= 3000) return 0.85;
  if (len <= 8000) return 0.7;
  return 0.55; // too verbose
}

function determineAction(score: number): EvalAction {
  if (score >= CONFIDENCE_THRESHOLD) return "accept";
  if (score >= 0.45) return "retry_with_context";
  if (score >= 0.25) return "replan";
  return "escalate";
}
