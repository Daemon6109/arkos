// ─── Diff-Based Patcher ───────────────────────────────────────────────────────
// Surgical patch generation and application without external diff binaries.

import { readFile, writeFile } from "fs/promises";
import { resolve } from "path";
import { generate } from "../ollama.js";

export interface FilePatch {
  path: string;
  hunks: PatchHunk[];
}

export interface PatchHunk {
  startLine: number;
  deleteLines: string[];   // lines to remove
  insertLines: string[];   // lines to add
}

// ─── generateDiff ─────────────────────────────────────────────────────────────

/**
 * Generate a unified diff between originalContent and newContent.
 * Pure TypeScript — no external diff binary required.
 */
export function generateDiff(
  originalContent: string,
  newContent: string,
  filePath: string
): string {
  const CONTEXT = 3;

  const origLines = originalContent.split("\n");
  const newLines = newContent.split("\n");

  // Myers-style LCS to compute edit script
  const lcs = computeLCS(origLines, newLines);

  // Build list of edits: { type: 'keep'|'delete'|'insert', line: string }
  type Edit = { type: "keep" | "delete" | "insert"; line: string };
  const edits: Edit[] = [];

  let oi = 0;
  let ni = 0;
  for (const [lo, ln] of lcs) {
    // Lines in orig before this LCS entry → deleted
    while (oi < lo) {
      edits.push({ type: "delete", line: origLines[oi++] });
    }
    // Lines in new before this LCS entry → inserted
    while (ni < ln) {
      edits.push({ type: "insert", line: newLines[ni++] });
    }
    edits.push({ type: "keep", line: origLines[oi++] });
    ni++;
  }
  while (oi < origLines.length) {
    edits.push({ type: "delete", line: origLines[oi++] });
  }
  while (ni < newLines.length) {
    edits.push({ type: "insert", line: newLines[ni++] });
  }

  if (!edits.some((e) => e.type !== "keep")) {
    return ""; // no changes
  }

  // Group edits into hunks with CONTEXT lines around changes
  const hunks: string[] = [];
  let i = 0;
  while (i < edits.length) {
    if (edits[i].type === "keep") {
      i++;
      continue;
    }
    // Found a change — collect the hunk
    const hunkStart = Math.max(0, i - CONTEXT);
    let hunkEnd = i;
    // Extend to include all consecutive changes + trailing context
    while (hunkEnd < edits.length) {
      if (edits[hunkEnd].type !== "keep") {
        hunkEnd++;
      } else {
        // Keep lines after last change as context
        const trailerEnd = Math.min(edits.length, hunkEnd + CONTEXT);
        // Check if there's another change within CONTEXT
        let hasMore = false;
        for (let k = hunkEnd + 1; k < trailerEnd; k++) {
          if (edits[k].type !== "keep") { hasMore = true; break; }
        }
        if (hasMore) {
          hunkEnd = trailerEnd;
        } else {
          hunkEnd = Math.min(edits.length, hunkEnd + CONTEXT);
          break;
        }
      }
    }

    // Compute original / new line numbers
    let origLine = 1;
    let newLine = 1;
    for (let k = 0; k < hunkStart; k++) {
      if (edits[k].type !== "insert") origLine++;
      if (edits[k].type !== "delete") newLine++;
    }

    let origCount = 0;
    let newCount = 0;
    const hunkLines: string[] = [];
    for (let k = hunkStart; k < hunkEnd; k++) {
      const e = edits[k];
      if (e.type === "keep") {
        hunkLines.push(` ${e.line}`);
        origCount++;
        newCount++;
      } else if (e.type === "delete") {
        hunkLines.push(`-${e.line}`);
        origCount++;
      } else {
        hunkLines.push(`+${e.line}`);
        newCount++;
      }
    }

    hunks.push(
      `@@ -${origLine},${origCount} +${newLine},${newCount} @@\n${hunkLines.join("\n")}`
    );

    i = hunkEnd;
  }

  if (hunks.length === 0) return "";

  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    ...hunks,
    "",
  ].join("\n");
}

// Longest Common Subsequence — returns pairs [origIdx, newIdx]
function computeLCS(a: string[], b: string[]): [number, number][] {
  const m = a.length;
  const n = b.length;

  // For large files use a sparse approach; for small files use full DP
  if (m * n > 1_000_000) {
    return computeLCSSparse(a, b);
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack
  const result: [number, number][] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return result.reverse();
}

// Sparse LCS for large files: match by content hash
function computeLCSSparse(a: string[], b: string[]): [number, number][] {
  // Build index of b lines
  const bIndex = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const arr = bIndex.get(b[j]);
    if (arr) arr.push(j);
    else bIndex.set(b[j], [j]);
  }

  // Patience sort approach: find increasing subsequence
  const matches: [number, number][] = [];
  for (let i = 0; i < a.length; i++) {
    const bIdxs = bIndex.get(a[i]);
    if (bIdxs) {
      for (const j of bIdxs) {
        matches.push([i, j]);
      }
    }
  }

  // Extract longest increasing subsequence on j (given i is already increasing)
  return lisOnSecond(matches);
}

function lisOnSecond(pairs: [number, number][]): [number, number][] {
  if (pairs.length === 0) return [];
  const tails: number[] = []; // tails[i] = smallest j ending a subsequence of length i+1
  const prev: number[] = new Array(pairs.length).fill(-1);
  const pos: number[] = [];

  for (let k = 0; k < pairs.length; k++) {
    const j = pairs[k][1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < j) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = j;
    pos[k] = lo;
    if (lo > 0) {
      // Find previous element
      for (let p = k - 1; p >= 0; p--) {
        if (pos[p] === lo - 1 && pairs[p][1] < j) {
          prev[k] = p;
          break;
        }
      }
    }
  }

  // Reconstruct
  const len = tails.length;
  const result: [number, number][] = [];
  let k = -1;
  for (let p = pairs.length - 1; p >= 0; p--) {
    if (pos[p] === len - 1 && k === -1) { k = p; }
  }
  while (k !== -1) {
    result.push(pairs[k]);
    k = prev[k];
  }
  return result.reverse();
}

// ─── applyPatch ───────────────────────────────────────────────────────────────

/**
 * Apply a unified diff string to the target file(s) in repoDir.
 * Returns { success: true } on success or { success: false, error } on failure.
 */
export async function applyPatch(
  repoDir: string,
  diffContent: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const parsed = parseDiff(diffContent);
    if (parsed.length === 0) {
      return { success: false, error: "No parseable diff hunks found" };
    }

    for (const fileDiff of parsed) {
      const filePath = resolve(repoDir, fileDiff.path);
      let lines: string[];
      try {
        const raw = await readFile(filePath, "utf-8");
        lines = raw.split("\n");
      } catch {
        // New file — start empty
        lines = [];
      }

      for (const hunk of fileDiff.hunks) {
        const result = applyHunk(lines, hunk);
        if (!result.success) {
          return { success: false, error: `Hunk failed at line ~${hunk.origStart}: ${result.error}` };
        }
        lines = result.lines!;
      }

      await writeFile(filePath, lines.join("\n"), "utf-8");
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

interface ParsedHunk {
  origStart: number;
  origCount: number;
  newStart: number;
  newCount: number;
  lines: string[]; // raw hunk lines (with +/-/ prefix)
}

interface ParsedFileDiff {
  path: string;
  hunks: ParsedHunk[];
}

function parseDiff(diff: string): ParsedFileDiff[] {
  const lines = diff.split("\n");
  const files: ParsedFileDiff[] = [];
  let current: ParsedFileDiff | null = null;
  let currentHunk: ParsedHunk | null = null;

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      // New file diff
      if (current && currentHunk) current.hunks.push(currentHunk);
      currentHunk = null;
      current = null;
    } else if (line.startsWith("+++ ")) {
      // Extract path: strip b/ prefix
      const rawPath = line.slice(4).replace(/^b\//, "");
      current = { path: rawPath, hunks: [] };
      files.push(current);
    } else if (line.startsWith("@@")) {
      if (current && currentHunk) current.hunks.push(currentHunk);
      // Parse @@ -a,b +c,d @@
      const m = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m && current) {
        currentHunk = {
          origStart: parseInt(m[1], 10),
          origCount: m[2] !== undefined ? parseInt(m[2], 10) : 1,
          newStart: parseInt(m[3], 10),
          newCount: m[4] !== undefined ? parseInt(m[4], 10) : 1,
          lines: [],
        };
      }
    } else if (currentHunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      currentHunk.lines.push(line);
    }
  }

  if (current && currentHunk) current.hunks.push(currentHunk);

  return files;
}

function applyHunk(
  lines: string[],
  hunk: ParsedHunk
): { success: boolean; lines?: string[]; error?: string } {
  // origStart is 1-indexed
  let pos = hunk.origStart - 1;
  const result = [...lines.slice(0, pos)];

  for (const hl of hunk.lines) {
    const prefix = hl[0];
    const content = hl.slice(1);

    if (prefix === " ") {
      // Context line — must match
      if (lines[pos] !== content) {
        return {
          success: false,
          error: `Context mismatch at line ${pos + 1}: expected "${content}", got "${lines[pos]}"`,
        };
      }
      result.push(content);
      pos++;
    } else if (prefix === "-") {
      // Delete — must match
      if (lines[pos] !== content) {
        return {
          success: false,
          error: `Delete mismatch at line ${pos + 1}: expected "${content}", got "${lines[pos]}"`,
        };
      }
      pos++; // skip (don't push)
    } else if (prefix === "+") {
      // Insert
      result.push(content);
    }
  }

  // Append remaining lines
  result.push(...lines.slice(pos));
  return { success: true, lines: result };
}

// ─── generatePatchWithLLM ─────────────────────────────────────────────────────

/**
 * Ask an LLM to produce a surgical unified diff patch for a specific instruction.
 * Returns the diff string extracted from the model's response.
 */
export async function generatePatchWithLLM(
  filePath: string,
  originalContent: string,
  instruction: string,
  model = "qwen2.5-coder:14b"
): Promise<string> {
  const prompt = `You are a precise code editor. Your task is to produce a unified diff patch.

FILE: ${filePath}
ORIGINAL CONTENT:
\`\`\`
${originalContent}
\`\`\`

INSTRUCTION: ${instruction}

Output ONLY a unified diff in a \`\`\`diff code block. Do not include any explanation, commentary, or other text.
The diff must be in standard unified format (--- a/path, +++ b/path, @@ hunks).
Do not rewrite the whole file — only change what is necessary.`;

  const response = await generate(prompt, { model }, "patcher");

  // Extract diff from ```diff ... ``` block
  const diffMatch = response.match(/```diff\s*([\s\S]*?)```/);
  if (diffMatch) {
    return diffMatch[1].trim();
  }

  // Fallback: look for --- / +++ lines directly
  const lines = response.split("\n");
  const diffStart = lines.findIndex((l) => l.startsWith("---"));
  if (diffStart !== -1) {
    return lines.slice(diffStart).join("\n").trim();
  }

  // No diff found — return empty string; caller should fall back to full rewrite
  return "";
}
