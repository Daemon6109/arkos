// ─── TypeScript Compiler Feedback Loop ───────────────────────────────────────
// Run tsc and parse its output for consumption by LLM agents.

import { exec as cpExec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(cpExec);

export interface TscResult {
  success: boolean;
  errors: Array<{ file: string; line: number; col: number; message: string }>;
  errorCount: number;
}

/**
 * Run `tsc --noEmit` in repoDir and parse its output.
 * Returns a structured TscResult regardless of success or failure.
 */
export async function runTsc(repoDir: string): Promise<TscResult> {
  let output = "";

  try {
    const { stdout, stderr } = await execAsync("bunx tsc --noEmit", {
      cwd: repoDir,
      timeout: 120_000,
    });
    output = stdout + stderr;
  } catch (err: unknown) {
    // tsc exits non-zero when there are type errors — that's normal
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    output = (execErr.stdout ?? "") + (execErr.stderr ?? "");
    if (!output && execErr.message) {
      output = execErr.message;
    }
  }

  const errors = parseTscOutput(output);
  return {
    success: errors.length === 0,
    errors,
    errorCount: errors.length,
  };
}

/**
 * Parse tsc output lines into structured error objects.
 * tsc format: path/to/file.ts(line,col): error TS####: message
 */
function parseTscOutput(
  output: string
): Array<{ file: string; line: number; col: number; message: string }> {
  const errors: Array<{ file: string; line: number; col: number; message: string }> = [];

  // Match: some/path.ts(5,3): error TS2304: Cannot find name 'x'.
  const pattern = /^(.+\.tsx?)\((\d+),(\d+)\): error TS\d+: (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(output)) !== null) {
    errors.push({
      file: m[1],
      line: parseInt(m[2], 10),
      col: parseInt(m[3], 10),
      message: m[4].trim(),
    });
  }

  return errors;
}

/**
 * Format TscResult into a concise human/LLM-readable error summary.
 * e.g. "3 errors:\n  src/foo.ts:5:3 - Cannot find name 'x'\n  ..."
 */
export function formatTscErrors(result: TscResult): string {
  if (result.success) {
    return "TypeScript: no errors";
  }

  const lines = result.errors.map(
    (e) => `  ${e.file}:${e.line}:${e.col} - ${e.message}`
  );

  return `${result.errorCount} TypeScript error${result.errorCount === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}
