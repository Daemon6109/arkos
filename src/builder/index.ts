// ─── Builder ──────────────────────────────────────────────────────────────────
// Runs the full build/lint/test loop on the generated project.
// On failure: sends errors to the debugger worker, patches files, retries.
// Uses Bun (runtime + test runner) + Biome (lint + format).

import { exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { generate, stripThinking } from "../ollama.js";

const execAsync = promisify(exec);

const MAX_FIX_ROUNDS = 3;

export interface BuildResult {
  installed: boolean;
  linted: boolean;
  typeChecked: boolean;
  testsRan: boolean;
  testsPassed: boolean;
  fixRounds: number;
  errors: string[];
  summary: string;
}

export async function buildAndTest(
  outputDir: string,
  language: string
): Promise<BuildResult> {
  const result: BuildResult = {
    installed: false,
    linted: false,
    typeChecked: false,
    testsRan: false,
    testsPassed: false,
    fixRounds: 0,
    errors: [],
    summary: "",
  };

  // ── 1. bun install ────────────────────────────────────────────────────────
  console.log("    📦 bun install...");
  try {
    await run("bun install", outputDir);
    result.installed = true;
    console.log("    ✓ deps installed");
  } catch (err) {
    result.errors.push(`bun install failed: ${err}`);
    console.log(`    ✗ bun install: ${err}`);
    // Non-fatal — continue anyway
  }

  // ── 2. Biome lint + format ────────────────────────────────────────────────
  if (existsSync(join(outputDir, "biome.json"))) {
    console.log("    🧹 biome check --apply...");
    try {
      await run("bunx biome check --apply src/", outputDir);
      result.linted = true;
      console.log("    ✓ lint + format");
    } catch (err) {
      // Biome exits non-zero when it finds issues but still applies fixes
      // Only fail if it couldn't run at all
      const errStr = String(err);
      if (errStr.includes("not found") || errStr.includes("ENOENT")) {
        console.log(`    ✗ biome not available: ${err}`);
      } else {
        result.linted = true; // it ran and applied fixes, exit code just means there were issues
        console.log("    ✓ biome applied fixes");
      }
    }
  }

  // ── 3. Type check + fix loop (TypeScript only) ────────────────────────────
  if (language === "TypeScript") {
    for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
      console.log(`    🔍 tsc type check${round > 0 ? ` (fix round ${round})` : ""}...`);
      try {
        await run("bunx tsc --noEmit", outputDir);
        result.typeChecked = true;
        console.log("    ✓ type check passed");
        break;
      } catch (err) {
        const errors = String(err);
        if (round === MAX_FIX_ROUNDS) {
          console.log(`    ✗ type check failed after ${MAX_FIX_ROUNDS} fix rounds`);
          result.errors.push(errors.slice(0, 500));
          break;
        }
        console.log(`    ⚠️  type errors found — sending to debugger (round ${round + 1})`);
        result.fixRounds++;
        const fixed = await fixErrors(errors, outputDir, "TypeScript", "type errors");
        if (!fixed) break;
      }
    }
  }

  // ── 4. bun test + fix loop ────────────────────────────────────────────────
  const testsDir = join(outputDir, "tests");
  if (existsSync(testsDir)) {
    for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
      console.log(`    🧪 bun test${round > 0 ? ` (fix round ${round})` : ""}...`);
      try {
        const { stdout, stderr } = await run("bun test tests/ --reporter=verbose 2>&1 || true", outputDir);
        const output = stdout + stderr;
        result.testsRan = true;

        const passed = parseTestResults(output);
        if (passed.failed === 0) {
          result.testsPassed = true;
          console.log(`    ✓ ${passed.total} test(s) passed`);
          break;
        } else {
          console.log(`    ⚠️  ${passed.failed}/${passed.total} tests failed`);
          if (round === MAX_FIX_ROUNDS) {
            result.errors.push(`${passed.failed} tests still failing after ${MAX_FIX_ROUNDS} fix rounds`);
            break;
          }
          result.fixRounds++;
          const fixed = await fixErrors(output, outputDir, language, "test failures");
          if (!fixed) break;
        }
      } catch (err) {
        result.testsRan = true;
        const errors = String(err);
        if (round === MAX_FIX_ROUNDS) {
          result.errors.push(errors.slice(0, 500));
          break;
        }
        result.fixRounds++;
        await fixErrors(errors, outputDir, language, "test runtime error");
      }
    }
  } else {
    console.log("    ⚠️  no tests/ dir found — skipping test run");
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const parts = [
    result.installed ? "✓ installed" : "✗ install failed",
    result.linted ? "✓ linted" : "~ lint skipped",
    result.typeChecked ? "✓ types OK" : "✗ type errors",
    result.testsRan
      ? result.testsPassed ? "✓ tests pass" : "✗ tests fail"
      : "~ no tests run",
  ];
  result.summary = parts.join(" | ");
  if (result.fixRounds > 0) result.summary += ` (${result.fixRounds} auto-fix round(s))`;

  return result;
}

// ─── Error fixer ──────────────────────────────────────────────────────────────
// Sends compiler/test errors to qwen2.5-coder:14b, applies patches to files.

async function fixErrors(
  errors: string,
  outputDir: string,
  lang: string,
  errorType: string
): Promise<boolean> {
  // Read all src files to give debugger full context
  const srcFiles = await readSrcFiles(outputDir);
  if (srcFiles.length === 0) return false;

  const filesSection = srcFiles
    .map(f => `// FILE: ${f.path}\n${f.content}`)
    .join("\n\n---\n\n");

  const prompt = `You are an expert ${lang} debugger. Fix these ${errorType}.

ERRORS:
${errors.slice(0, 2000)}

CURRENT SOURCE FILES:
${filesSection.slice(0, 6000)}

Return ONLY a JSON array of file patches. Each patch has the file path and complete corrected content:
[
  {
    "path": "src/scanner.ts",
    "content": "// complete corrected file content here"
  }
]

Fix ONLY what's broken. Don't rewrite files that don't have errors.`;

  try {
    const raw = await generate(prompt, {
      model: "qwen2.5-coder:14b",
      temperature: 0.2,
      num_ctx: 12000,
    });
    const cleaned = stripThinking(raw);

    const jsonStr = (() => {
      const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenced) return fenced[1].trim();
      const s = cleaned.indexOf("["); const e = cleaned.lastIndexOf("]");
      if (s !== -1 && e > s) return cleaned.slice(s, e + 1);
      return "[]";
    })();

    const patches: Array<{ path: string; content: string }> = JSON.parse(jsonStr);

    for (const patch of patches) {
      const fullPath = join(outputDir, patch.path);
      if (existsSync(fullPath) && patch.content) {
        await writeFile(fullPath, patch.content, "utf-8");
        console.log(`    🔧 patched ${patch.path}`);
      }
    }

    return patches.length > 0;
  } catch {
    return false;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function run(
  cmd: string,
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  return execAsync(cmd, { cwd, env: { ...process.env, PATH: `/home/matthew/.bun/bin:${process.env.PATH}` } });
}

async function readSrcFiles(outputDir: string): Promise<Array<{ path: string; content: string }>> {
  const { readdir } = await import("fs/promises");
  const results: Array<{ path: string; content: string }> = [];
  const srcDir = join(outputDir, "src");
  if (!existsSync(srcDir)) return results;
  const entries = await readdir(srcDir).catch(() => [] as string[]);
  for (const entry of entries) {
    try {
      const content = await readFile(join(srcDir, entry), "utf-8");
      results.push({ path: `src/${entry}`, content });
    } catch {}
  }
  return results;
}

function parseTestResults(output: string): { total: number; failed: number; passed: number } {
  const passMatch = output.match(/(\d+)\s+pass/i);
  const failMatch = output.match(/(\d+)\s+fail/i);
  const passed = parseInt(passMatch?.[1] ?? "0");
  const failed = parseInt(failMatch?.[1] ?? "0");
  return { total: passed + failed, failed, passed };
}
