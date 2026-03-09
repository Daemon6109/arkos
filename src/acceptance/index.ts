// ─── Acceptance Criteria ─────────────────────────────────────────────────────
// Generates and runs post-pipeline acceptance checks to verify deliverables.

import { existsSync, statSync, readFileSync } from "fs";
import { join } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import type { FileMapEntry } from "../types.js";

const execAsync = promisify(exec);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AcceptanceCriterion {
  id: string;
  description: string;
  check: (outputDir: string) => Promise<boolean>;
}

export interface AcceptanceResult {
  passed: boolean;
  total: number;
  passing: number;
  failing: AcceptanceCriterion[];
  report: string;  // human-readable summary
}

// ─── Criteria Generators ──────────────────────────────────────────────────────

function entryPointCriterion(): AcceptanceCriterion {
  return {
    id: "entry-point-exists",
    description: "Entry point file exists (src/index.ts, src/main.ts, or src/index.js)",
    check: async (outputDir: string) => {
      const candidates = [
        join(outputDir, "src", "index.ts"),
        join(outputDir, "src", "main.ts"),
        join(outputDir, "src", "index.js"),
      ];
      return candidates.some((p) => existsSync(p));
    },
  };
}

function fileMapExistsCriterion(entry: FileMapEntry): AcceptanceCriterion {
  return {
    id: `file-exists:${entry.path}`,
    description: `File exists: ${entry.path}`,
    check: async (outputDir: string) => {
      return existsSync(join(outputDir, entry.path));
    },
  };
}

function noEmptyFilesCriterion(entries: FileMapEntry[]): AcceptanceCriterion {
  return {
    id: "no-empty-files",
    description: "No planned file is empty (< 20 bytes)",
    check: async (outputDir: string) => {
      for (const entry of entries) {
        const fullPath = join(outputDir, entry.path);
        if (!existsSync(fullPath)) continue; // covered by file-exists criterion
        try {
          const stats = statSync(fullPath);
          if (stats.size < 20) return false;
        } catch {
          return false;
        }
      }
      return true;
    },
  };
}

function packageJsonCriterion(): AcceptanceCriterion {
  return {
    id: "package-json-valid",
    description: "package.json exists and has a 'start' or 'main' field",
    check: async (outputDir: string) => {
      const pkgPath = join(outputDir, "package.json");
      if (!existsSync(pkgPath)) return false;
      try {
        const raw = readFileSync(pkgPath, "utf-8");
        const pkg = JSON.parse(raw) as Record<string, unknown>;
        const scripts = pkg.scripts as Record<string, unknown> | undefined;
        const hasStart = scripts && typeof scripts["start"] === "string";
        const hasMain = typeof pkg["main"] === "string";
        return !!(hasStart || hasMain);
      } catch {
        return false;
      }
    },
  };
}

function typeScriptCriterion(language: string): AcceptanceCriterion | null {
  if (!language.toLowerCase().includes("typescript")) return null;
  return {
    id: "no-typescript-errors",
    description: "No TypeScript errors (bunx tsc --noEmit exits 0)",
    check: async (outputDir: string) => {
      try {
        await execAsync("bunx tsc --noEmit", { cwd: outputDir, timeout: 60_000 });
        return true;
      } catch {
        return false;
      }
    },
  };
}

function testsCriterion(): AcceptanceCriterion {
  return {
    id: "tests-pass",
    description: "Tests pass (bun test tests/ exits 0, if tests/ dir exists)",
    check: async (outputDir: string) => {
      const testsDir = join(outputDir, "tests");
      if (!existsSync(testsDir)) return true; // no tests dir → skip
      try {
        await execAsync("bun test tests/", { cwd: outputDir, timeout: 120_000 });
        return true;
      } catch {
        return false;
      }
    },
  };
}

function exportsKeywordCriteria(entries: FileMapEntry[]): AcceptanceCriterion[] {
  return entries
    .filter((e) => e.exports && e.exports.length > 0)
    .map((entry) => ({
      id: `exports-keyword:${entry.path}`,
      description: `File with declared exports contains 'export' keyword: ${entry.path}`,
      check: async (outputDir: string): Promise<boolean> => {
        const fullPath = join(outputDir, entry.path);
        if (!existsSync(fullPath)) return false;
        try {
          const content = readFileSync(fullPath, "utf-8");
          return content.includes("export");
        } catch {
          return false;
        }
      },
    }));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function generateCriteria(
  _goal: string,
  fileMap: FileMapEntry[],
  language: string
): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [];

  // 1. Entry point exists
  criteria.push(entryPointCriterion());

  // 2. Each file in fileMap must exist on disk
  for (const entry of fileMap) {
    criteria.push(fileMapExistsCriterion(entry));
  }

  // 3. TypeScript type-check (if applicable)
  const tsCriterion = typeScriptCriterion(language);
  if (tsCriterion) criteria.push(tsCriterion);

  // 4. Tests pass (if tests/ dir exists)
  criteria.push(testsCriterion());

  // 5. package.json exists and has start/main
  criteria.push(packageJsonCriterion());

  // 6. No empty files
  criteria.push(noEmptyFilesCriterion(fileMap));

  // 7. Export keyword present in files that declare exports
  criteria.push(...exportsKeywordCriteria(fileMap));

  return criteria;
}

export async function runAcceptance(
  criteria: AcceptanceCriterion[],
  outputDir: string
): Promise<AcceptanceResult> {
  // Run all checks in parallel
  const results = await Promise.all(
    criteria.map(async (c) => {
      try {
        const passed = await c.check(outputDir);
        return { criterion: c, passed };
      } catch {
        return { criterion: c, passed: false };
      }
    })
  );

  const passing = results.filter((r) => r.passed).length;
  const failing = results.filter((r) => !r.passed).map((r) => r.criterion);
  const total = criteria.length;
  const passed = failing.length === 0;

  const lines: string[] = [
    `Acceptance: ${passing}/${total} criteria passed`,
  ];
  if (failing.length > 0) {
    lines.push("Failing:");
    for (const c of failing) {
      lines.push(`  ❌ [${c.id}] ${c.description}`);
    }
  } else {
    lines.push("✅ All acceptance criteria met");
  }

  return {
    passed,
    total,
    passing,
    failing,
    report: lines.join("\n"),
  };
}
