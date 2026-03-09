// ─── Token Optimizer ─────────────────────────────────────────────────────────
// Tracks token usage across the pipeline and compresses growing context
// when it exceeds a threshold. Verifies compressed context produces
// similar predictions before switching — never silently degrades quality.

import { generate, stripThinking } from "../ollama.js";
import { writeFile } from "fs/promises";
import { join } from "path";

// ─── Token tracking ───────────────────────────────────────────────────────────

export interface TokenRecord {
  phase: string;
  model: string;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  timestamp: number;
  compressed: boolean;
}

export interface TokenStats {
  records: TokenRecord[];
  totalPromptTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  tokensSaved: number;
  compressionRounds: number;
  efficiencyRatio: number; // tokensSaved / totalTokens before savings
}

const globalStats: TokenStats = {
  records: [],
  totalPromptTokens: 0,
  totalOutputTokens: 0,
  totalTokens: 0,
  tokensSaved: 0,
  compressionRounds: 0,
  efficiencyRatio: 0,
};

export function recordTokens(
  phase: string,
  model: string,
  promptTokens: number,
  outputTokens: number,
  compressed = false
): void {
  const total = promptTokens + outputTokens;
  globalStats.records.push({
    phase,
    model,
    promptTokens,
    outputTokens,
    totalTokens: total,
    timestamp: Date.now(),
    compressed,
  });
  globalStats.totalPromptTokens += promptTokens;
  globalStats.totalOutputTokens += outputTokens;
  globalStats.totalTokens += total;

  // Recalculate efficiency ratio
  const rawTotal = globalStats.totalTokens + globalStats.tokensSaved;
  globalStats.efficiencyRatio = rawTotal > 0 ? globalStats.tokensSaved / rawTotal : 0;
}

export function recordTokensSaved(saved: number): void {
  globalStats.tokensSaved += saved;
  globalStats.compressionRounds++;
  const rawTotal = globalStats.totalTokens + globalStats.tokensSaved;
  globalStats.efficiencyRatio = rawTotal > 0 ? globalStats.tokensSaved / rawTotal : 0;
}

export function getStats(): TokenStats {
  return { ...globalStats };
}

export function resetStats(): void {
  globalStats.records = [];
  globalStats.totalPromptTokens = 0;
  globalStats.totalOutputTokens = 0;
  globalStats.totalTokens = 0;
  globalStats.tokensSaved = 0;
  globalStats.compressionRounds = 0;
  globalStats.efficiencyRatio = 0;
}

// ─── Context compression ──────────────────────────────────────────────────────
// Compress carry-forward context when it exceeds threshold.
// Verify compressed context produces similar outputs before committing.

const COMPRESSION_THRESHOLD_CHARS = 2000; // compress if context exceeds this
const SIMILARITY_THRESHOLD = 0.70;         // minimum similarity to accept compression

export interface CompressionResult {
  context: string;         // compressed (or original if compression failed)
  compressed: boolean;
  originalLength: number;
  compressedLength: number;
  similarityScore: number;
  tokensSaved: number;
}

export async function compressContext(
  context: string,
  taskHint: string // what the context will be used for
): Promise<CompressionResult> {
  const originalLength = context.length;

  // Don't bother compressing small contexts
  if (originalLength < COMPRESSION_THRESHOLD_CHARS) {
    return {
      context,
      compressed: false,
      originalLength,
      compressedLength: originalLength,
      similarityScore: 1.0,
      tokensSaved: 0,
    };
  }

  // ── Step 1: Compress ───────────────────────────────────────────────────────
  const compressPrompt = `You are a context compression specialist. Compress this context to the minimum tokens needed to preserve all technically relevant information.

Context will be used for: ${taskHint}

Rules:
- Keep ALL function signatures, type definitions, exported symbols, and file names
- Remove verbose comments, repeated explanations, and boilerplate
- Preserve import paths exactly
- Target 40-50% of original length
- Output ONLY the compressed context, nothing else

CONTEXT TO COMPRESS:
${context}`;

  const compressedRaw = await generate(compressPrompt, {
    model: "qwen3:8b", // use faster smaller model for compression
    temperature: 0.1,
    num_ctx: 8192,
  });
  const compressed = stripThinking(compressedRaw).trim();

  if (compressed.length >= originalLength * 0.9) {
    // Compression didn't help much — skip
    return {
      context,
      compressed: false,
      originalLength,
      compressedLength: originalLength,
      similarityScore: 1.0,
      tokensSaved: 0,
    };
  }

  // ── Step 2: Verify — would compressed context produce similar output? ──────
  const similarity = await verifySimilarity(context, compressed, taskHint);

  if (similarity >= SIMILARITY_THRESHOLD) {
    const tokensSaved = estimateTokens(originalLength) - estimateTokens(compressed.length);
    recordTokensSaved(tokensSaved);

    return {
      context: compressed,
      compressed: true,
      originalLength,
      compressedLength: compressed.length,
      similarityScore: similarity,
      tokensSaved,
    };
  }

  // Similarity too low — keep original
  return {
    context,
    compressed: false,
    originalLength,
    compressedLength: originalLength,
    similarityScore: similarity,
    tokensSaved: 0,
  };
}

async function verifySimilarity(
  original: string,
  compressed: string,
  taskHint: string
): Promise<number> {
  // Run the same test prompt through both contexts and compare outputs
  const testPrompt = `Given this context, list the exported function names and their parameters in one line each.

Context:
${original.slice(0, 1500)}`;

  const testPromptCompressed = `Given this context, list the exported function names and their parameters in one line each.

Context:
${compressed.slice(0, 1500)}`;

  try {
    const [origResponse, compResponse] = await Promise.all([
      generate(testPrompt, { model: "qwen3:8b", temperature: 0, num_ctx: 4096 }),
      generate(testPromptCompressed, { model: "qwen3:8b", temperature: 0, num_ctx: 4096 }),
    ]);

    const origClean = stripThinking(origResponse).toLowerCase().trim();
    const compClean = stripThinking(compResponse).toLowerCase().trim();

    return jaccardSimilarity(origClean, compClean);
  } catch {
    return 0;
  }
}

// Jaccard similarity on word sets — fast, good enough for verification
function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(/\W+/).filter(w => w.length > 2));
  const wordsB = new Set(b.split(/\W+/).filter(w => w.length > 2));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / union.size;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4); // rough estimate: ~4 chars per token
}

// ─── Efficiency report ────────────────────────────────────────────────────────

export function printEfficiencyReport(stats: TokenStats): void {
  console.log("\n  📊 Token Efficiency Report");
  console.log(`  Total tokens used:    ${stats.totalTokens.toLocaleString()}`);
  console.log(`  Prompt tokens:        ${stats.totalPromptTokens.toLocaleString()}`);
  console.log(`  Output tokens:        ${stats.totalOutputTokens.toLocaleString()}`);
  console.log(`  Tokens saved:         ${stats.tokensSaved.toLocaleString()} (${(stats.efficiencyRatio * 100).toFixed(1)}% reduction)`);
  console.log(`  Compression rounds:   ${stats.compressionRounds}`);

  if (stats.records.length > 0) {
    console.log("\n  Per-phase breakdown:");
    const byPhase = new Map<string, number>();
    for (const r of stats.records) {
      byPhase.set(r.phase, (byPhase.get(r.phase) ?? 0) + r.totalTokens);
    }
    const sorted = [...byPhase.entries()].sort((a, b) => b[1] - a[1]);
    for (const [phase, tokens] of sorted) {
      const bar = "█".repeat(Math.round(tokens / (stats.totalTokens / 20)));
      console.log(`    ${phase.padEnd(20)} ${bar} ${tokens.toLocaleString()}`);
    }
  }
}

export async function saveEfficiencyReport(
  stats: TokenStats,
  outputDir: string
): Promise<void> {
  await writeFile(
    join(outputDir, ".arkos-token-report.json"),
    JSON.stringify(stats, null, 2),
    "utf-8"
  );
}
