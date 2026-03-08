// ─── Memory System ────────────────────────────────────────────────────────────
// Persistent storage of lessons, run results, and patterns.
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
}

function memoryPath(): string {
  return join(homedir(), ".arkos", "memory.json");
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
  const path = memoryPath();
  mkdirSync(join(homedir(), ".arkos"), { recursive: true });
  writeFileSync(path, JSON.stringify(records, null, 2), "utf-8");
}

function extractLessons(eval_: RunEvaluation): string[] {
  const lessons: string[] = [];
  for (const te of eval_.taskEvaluations) {
    if (te.overall < 0.5) {
      lessons.push(`Low score (${te.overall.toFixed(2)}) on task ${te.taskId}: ${te.notes}`);
    }
    if (te.action === "escalate") {
      lessons.push(`Task required escalation: ${te.taskId}`);
    }
  }
  if (!eval_.passed) {
    lessons.push(`Run did not meet threshold (score: ${eval_.overallScore.toFixed(2)})`);
  }
  return lessons;
}

export async function storeRun(
  goal: string,
  vision: VisionObject,
  evaluation: RunEvaluation
): Promise<void> {
  const records = loadRecords();
  records.push({
    timestamp: Date.now(),
    goal,
    visionName: vision.name,
    overallScore: evaluation.overallScore,
    passed: evaluation.passed,
    lessons: extractLessons(evaluation),
  });
  saveRecords(records);
  console.log(`💾 Run saved to memory (${records.length} total records)`);
}

export function getRecentLessons(limit = 10): string[] {
  const records = loadRecords();
  return records
    .slice(-limit)
    .flatMap((r) => r.lessons);
}

export function getStats(): { total: number; passed: number; avgScore: number } {
  const records = loadRecords();
  if (records.length === 0) return { total: 0, passed: 0, avgScore: 0 };
  const passed = records.filter((r) => r.passed).length;
  const avgScore = records.reduce((sum, r) => sum + r.overallScore, 0) / records.length;
  return { total: records.length, passed, avgScore };
}
