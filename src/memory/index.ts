// ─── Memory System ────────────────────────────────────────────────────────────
// Persistent storage of lessons, run results, and patterns.
// Lessons from past runs feed back into the vision generator.
// v1: JSON file-based with semantic vector search via nomic-embed-text.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { VisionObject, RunEvaluation } from "../types.js";

const OLLAMA_BASE = "http://172.30.176.1:11434";
const EMBED_MODEL = "nomic-embed-text";

interface RunRecord {
  timestamp: number;
  goal: string;
  visionName: string;
  overallScore: number;
  passed: boolean;
  lessons: string[];
  outputDir?: string;
}

interface LessonEntry {
  text: string;
  embedding: number[];
  goal: string;
  timestamp: number;
}

interface MemoryStore {
  records: RunRecord[];
  lessonEntries: LessonEntry[];
}

// ─── Embedding ────────────────────────────────────────────────────────────────

async function embedText(text: string): Promise<number[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    });
    if (!res.ok) {
      console.warn(`⚠️  Embedding failed: ${res.status}`);
      return [];
    }
    const data = (await res.json()) as { embedding: number[] };
    return data.embedding ?? [];
  } catch (err) {
    console.warn(`⚠️  Embedding error: ${err}`);
    return [];
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Storage ──────────────────────────────────────────────────────────────────

function memoryDir(): string {
  return join(homedir(), ".arkos");
}

function memoryPath(): string {
  return join(memoryDir(), "memory.json");
}

function loadStore(): MemoryStore {
  const path = memoryPath();
  if (!existsSync(path)) return { records: [], lessonEntries: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    // Handle legacy format (plain array of RunRecords)
    if (Array.isArray(raw)) {
      return { records: raw as RunRecord[], lessonEntries: [] };
    }
    const store = raw as Partial<MemoryStore>;
    return {
      records: store.records ?? [],
      lessonEntries: store.lessonEntries ?? [],
    };
  } catch {
    return { records: [], lessonEntries: [] };
  }
}

function saveStore(store: MemoryStore): void {
  mkdirSync(memoryDir(), { recursive: true });
  writeFileSync(memoryPath(), JSON.stringify(store, null, 2), "utf-8");
}

// ─── Lesson Extraction ────────────────────────────────────────────────────────

function extractLessons(eval_: RunEvaluation, goal: string): string[] {
  const lessons: string[] = [];
  const goalType = goal.split(" ").slice(0, 5).join(" ");

  for (const te of eval_.taskEvaluations) {
    if (te.overall < 0.5) {
      lessons.push(`Low score (${te.overall.toFixed(2)}) on task "${te.taskId}" for "${goalType}" — more context needed`);
    }
    if (te.overall >= 0.85) {
      lessons.push(`High-quality task (${te.overall.toFixed(2)}) for "${goalType}" — approach worked well`);
    }
    if (te.action === "escalate") {
      lessons.push(`Task escalated and could not be auto-resolved: ${te.taskId} (goal: "${goalType}")`);
    }
    if (te.action === "replan") {
      lessons.push(`Task needed replanning — original plan insufficient for: "${goalType}"`);
    }
    if (te.action === "retry_with_context") {
      lessons.push(`Task ${te.taskId} needed retry for "${goalType}" — consider expanded context upfront`);
    }
  }

  if (!eval_.passed) {
    lessons.push(`Run for "${goalType}" did not pass threshold (${eval_.overallScore.toFixed(2)}) — review task complexity`);
  }

  // Always record a summary lesson for semantic retrieval
  const taskCount = eval_.taskEvaluations.length;
  const accepted = eval_.taskEvaluations.filter(t => t.action === "accept").length;
  lessons.push(
    `Goal type "${goalType}": ${taskCount} tasks, ${accepted} accepted, score ${eval_.overallScore.toFixed(2)}`
  );

  return lessons;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function storeRun(
  goal: string,
  vision: VisionObject,
  evaluation: RunEvaluation,
  outputDir?: string
): Promise<void> {
  const store = loadStore();

  const lessons = extractLessons(evaluation, goal);

  store.records.push({
    timestamp: Date.now(),
    goal,
    visionName: vision.name,
    overallScore: evaluation.overallScore,
    passed: evaluation.passed,
    lessons,
    outputDir,
  });

  // Embed each new lesson and add to lessonEntries
  const now = Date.now();
  for (const text of lessons) {
    const embedding = await embedText(text);
    store.lessonEntries.push({ text, embedding, goal, timestamp: now });
  }

  // Keep last 50 records and last 500 lesson entries
  store.records = store.records.slice(-50);
  store.lessonEntries = store.lessonEntries.slice(-500);

  saveStore(store);

  console.log(
    `💾 Run saved to memory (${store.records.length} records, ${store.lessonEntries.length} lessons)`
  );
}

/**
 * Semantic retrieval: embed query, rank lessons by cosine similarity.
 * Falls back gracefully if embeddings are unavailable (returns by recency).
 */
export async function getRelevantLessons(query: string, limit = 10): Promise<string[]> {
  const store = loadStore();

  if (store.lessonEntries.length === 0) {
    // No entries at all — fall back to pulling from RunRecord.lessons
    const legacyLessons = store.records
      .slice(-Math.ceil(limit * 2))
      .flatMap((r) => r.lessons)
      .slice(-limit);
    return legacyLessons;
  }

  const queryEmbedding = await embedText(query);

  // If embedding failed (empty vector), fall back to recency
  if (queryEmbedding.length === 0) {
    console.warn("⚠️  Could not embed query — falling back to recency");
    return store.lessonEntries
      .slice(-Math.ceil(limit * 2))
      .map((e) => e.text)
      .slice(-limit);
  }

  // Score all entries by cosine similarity
  const scored = store.lessonEntries
    .filter((e) => e.embedding.length > 0)
    .map((e) => ({ text: e.text, score: cosineSimilarity(queryEmbedding, e.embedding) }));

  // Include entries without embeddings at score 0
  const unembedded = store.lessonEntries
    .filter((e) => e.embedding.length === 0)
    .map((e) => ({ text: e.text, score: 0 }));

  const all = [...scored, ...unembedded];
  all.sort((a, b) => b.score - a.score);

  return all.slice(0, limit).map((e) => e.text);
}

/**
 * Returns recent lessons, or semantically relevant ones if a query is provided.
 * Kept for backward compatibility; prefer getRelevantLessons() for semantic use.
 */
export async function getRecentLessons(limit = 10, query?: string): Promise<string[]> {
  if (query) {
    return getRelevantLessons(query, limit);
  }
  const store = loadStore();
  // Fall back to recency from lessonEntries, else from records
  if (store.lessonEntries.length > 0) {
    return store.lessonEntries
      .slice(-Math.ceil(limit * 2))
      .map((e) => e.text)
      .slice(-limit);
  }
  return store.records
    .slice(-Math.ceil(limit * 2))
    .flatMap((r) => r.lessons)
    .slice(-limit);
}

export function getStats(): { total: number; passed: number; avgScore: number } {
  const store = loadStore();
  const records = store.records;
  if (records.length === 0) return { total: 0, passed: 0, avgScore: 0 };
  const passed = records.filter((r) => r.passed).length;
  const avgScore = records.reduce((sum, r) => sum + r.overallScore, 0) / records.length;
  return { total: records.length, passed, avgScore };
}
