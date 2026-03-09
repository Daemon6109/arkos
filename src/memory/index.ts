// ─── Memory System ────────────────────────────────────────────────────────────
// Persistent storage of lessons, run results, and patterns.
// Lessons from past runs feed back into the vision generator.
// v1: JSON file-based. v2: Qdrant vector DB for semantic retrieval.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { VisionObject, RunEvaluation } from "../types.js";

interface RunRecord {
  timestamp: number;
  goal: string;
  visionName: string;
  overallScore: number;
  passed: boolean;
  lessons: string[];
  outputDir?: string;
}

function memoryDir(): string {
  return join(homedir(), ".arkos");
}

function memoryPath(): string {
  return join(memoryDir(), "memory.json");
}

function loadRecords(): RunRecord[] {
  const path = memoryPath();
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RunRecord[];
  } catch {
    return [];
  }
}

function saveRecords(records: RunRecord[]): void {
  mkdirSync(memoryDir(), { recursive: true });
  writeFileSync(memoryPath(), JSON.stringify(records, null, 2), "utf-8");
}

function extractLessons(eval_: RunEvaluation, goal: string): string[] {
  const lessons: string[] = [];

  for (const te of eval_.taskEvaluations) {
    if (te.overall < 0.5) {
      lessons.push(
        `Low score (${te.overall.toFixed(2)}) on "${te.notes}" — consider more context`
      );
    }
    if (te.action === "escalate") {
      lessons.push(`Task escalated and could not be auto-resolved: ${te.taskId}`);
    }
    if (te.action === "replan") {
      lessons.push(`Task needed replanning — original plan was insufficient for goal type: ${goal}`);
    }
  }

  if (!eval_.passed) {
    lessons.push(
      `Run for "${goal}" did not pass threshold (score: ${eval_.overallScore.toFixed(2)})`
    );
  }

  if (eval_.overallScore >= 0.9) {
    lessons.push(`High-quality run (${eval_.overallScore.toFixed(2)}) for goal type: "${goal}"`);
  }

  return lessons;
}

export async function storeRun(
  goal: string,
  vision: VisionObject,
  evaluation: RunEvaluation,
  outputDir?: string
): Promise<void> {
  const records = loadRecords();

  records.push({
    timestamp: Date.now(),
    goal,
    visionName: vision.name,
    overallScore: evaluation.overallScore,
    passed: evaluation.passed,
    lessons: extractLessons(evaluation, goal),
    outputDir,
  });

  // Keep last 50 records
  const trimmed = records.slice(-50);
  saveRecords(trimmed);

  console.log(`💾 Run saved to memory (${trimmed.length} total records)`);
}

export function getRecentLessons(limit = 10): string[] {
  const records = loadRecords();
  return records
    .slice(-Math.ceil(limit * 2)) // look at recent records
    .flatMap((r) => r.lessons)
    .slice(-limit);               // return last N lessons
}

export function getStats(): { total: number; passed: number; avgScore: number } {
  const records = loadRecords();
  if (records.length === 0) return { total: 0, passed: 0, avgScore: 0 };
  const passed = records.filter((r) => r.passed).length;
  const avgScore = records.reduce((sum, r) => sum + r.overallScore, 0) / records.length;
  return { total: records.length, passed, avgScore };
}
