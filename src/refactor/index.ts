// ─── Refactor Pipeline ────────────────────────────────────────────────────────
// Cross-repo code analysis and refactoring via LLM-guided moves + PRs
// v2: Two-pass analysis to avoid context overload

import { cloneRepo, createBranch, commitAll, pushBranch, openPR } from "../tools/git.js";
import {
  readRepoStructure,
  readRepoFile,
  writeRepoFile,
  deleteRepoFile,
  type RepoStructure,
} from "../tools/repo_reader.js";
import { buildRepoMap, formatRepoMap, type RepoMap } from "../tools/repo_map.js";
import { generate, parseJsonSafe } from "../ollama.js";
import { join } from "path";
import { storeRefactorLesson, getRefactorLessons } from "../memory/index.js";

// Lazy-load tsc_checker so it degrades gracefully if not present
import type { TscResult } from "../tools/tsc_checker.js";
let runTsc: ((repoDir: string) => Promise<TscResult>) | null = null;
(async () => {
  try {
    const mod = await import("../tools/tsc_checker.js") as { runTsc: (repoDir: string) => Promise<TscResult> };
    runTsc = mod.runTsc;
  } catch {
    // tsc_checker not yet available — speculative execution will degrade gracefully
  }
})();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RefactorOptions {
  repos: string[];      // ["owner/repo1", "owner/repo2"]
  goal: string;         // natural language refactor description
  language?: string;
  openPR?: boolean;     // default true
  verbose?: boolean;
}

interface FileToMove {
  fromRepo: string;
  path: string;
  toRepo: string;
  targetPath: string;
  reason: string;
}

interface ImportToUpdate {
  repo: string;
  file: string;
  oldImport: string;
  newImport: string;
}

interface VersionBump {
  repo: string;
  packagePath: string;
  field: string;
  newValue: string;
}

interface RefactorPlan {
  filesToMove: FileToMove[];
  importsToUpdate: ImportToUpdate[];
  versionBumps: VersionBump[];
  summary: string;
}

interface CandidateList {
  candidates: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(msg);
}

/** Extract the short repo name (without owner) */
function repoShortName(ownerRepo: string): string {
  return ownerRepo.split("/")[1] ?? ownerRepo;
}

/** Build compact package.json summary for LLM (name, version, dependencies keys) */
function packageSummary(pkg: Record<string, unknown> | undefined): string {
  if (!pkg) return "(no package.json)";
  const deps = Object.keys((pkg.dependencies as Record<string, unknown>) ?? {});
  const devDeps = Object.keys((pkg.devDependencies as Record<string, unknown>) ?? {});
  return [
    `name: ${pkg.name ?? "?"}`,
    `version: ${pkg.version ?? "?"}`,
    deps.length > 0 ? `deps: ${deps.join(", ")}` : null,
    devDeps.length > 0 ? `devDeps: ${devDeps.slice(0, 10).join(", ")}${devDeps.length > 10 ? "..." : ""}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
}

// ─── Pass 1: Candidate identification ────────────────────────────────────────

/**
 * Pass 1 — Send only repo maps (no file contents) and ask the model which files
 * are worth examining. Returns up to 15 candidate paths.
 */
async function identifyCandidates(
  structures: RepoStructure[],
  repoMaps: RepoMap[],
  goal: string,
  language: string
): Promise<string[]> {
  const repoParts = structures.map((s, i) => {
    const map = repoMaps[i];
    return `REPO ${i + 1}: ${s.ownerRepo}
Package.json: ${packageSummary(s.packageJson)}
File tree:
${s.tree}
Symbol map:
${map.summary}`;
  });

  const prompt = `You are a senior ${language} architect reviewing ${structures.length} repos.
GOAL: ${goal}

${repoParts.join("\n\n")}

Based on the file trees and symbol maps, list up to 15 specific files that are strong candidates for moving between repos (shared utilities, types, duplicated logic, etc.).
Only list files that exist in the trees above.

Respond ONLY with valid JSON (no markdown, no extra text):
{ "candidates": ["src/shared/utils/server_time.ts", "src/types/index.ts"] }`;

  const raw = await generate(
    prompt,
    { model: "qwen3:14b", num_ctx: 16384, num_predict: 2048 },
    "refactor_pass1"
  );

  // Always log raw model output for pass 1 (it's short enough)
  log(`  🤖 Pass 1 raw output: ${raw.replace(/<think>[\s\S]*?<\/think>/g, "[thinking...]").slice(0, 400)}`);

  // extractJson grabs arrays first — if model returns ["file.ts"] instead of
  // {"candidates":["file.ts"]}, normalise it before parsing
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const arrOnly = stripped.match(/^\s*\[[\s\S]*\]\s*$/);
  const normalised = arrOnly ? `{"candidates":${stripped}}` : stripped;

  const result = parseJsonSafe<CandidateList>(normalised, { candidates: [] });

  // Also try pulling from raw fenced blocks if still empty
  if (result.candidates.length === 0) {
    const fenced = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      const inner = fenced[1].trim();
      const alt = parseJsonSafe<CandidateList>(
        inner.startsWith("[") ? `{"candidates":${inner}}` : inner,
        { candidates: [] }
      );
      if (alt.candidates.length > 0) result.candidates.push(...alt.candidates);
    }
  }

  // Last resort: extract quoted paths that look like file paths
  if (result.candidates.length === 0) {
    const paths = [...stripped.matchAll(/"((?:src|packages|lib|test)\/[^"]+\.[a-z]+)"/g)]
      .map(m => m[1]);
    if (paths.length > 0) result.candidates.push(...paths.slice(0, 15));
  }

  log(`  📋 Pass 1 identified ${result.candidates.length} candidate files:`);
  for (const c of result.candidates) {
    log(`    • ${c}`);
  }

  return result.candidates;
}

// ─── Pass 2: Full refactor plan ───────────────────────────────────────────────

/**
 * Pass 2 — Read actual contents of candidate files and ask for the full plan.
 */
async function buildRefactorPlan(
  structures: RepoStructure[],
  candidates: string[],
  goal: string,
  language: string,
  shortNameMap: Map<string, string>,
  clonedDirs: Map<string, string>,
  priorLessons: string[] = []
): Promise<RefactorPlan> {
  const fallback: RefactorPlan = {
    filesToMove: [],
    importsToUpdate: [],
    versionBumps: [],
    summary: "No plan generated",
  };

  if (candidates.length === 0) return fallback;

  // Read candidate file contents from all repos
  const fileContentParts: string[] = [];
  for (const structure of structures) {
    const shortName = repoShortName(structure.ownerRepo);
    const repoDir = clonedDirs.get(structure.ownerRepo) ?? "";

    for (const candidatePath of candidates) {
      const content = await readRepoFile(repoDir, candidatePath);
      if (content) {
        // Truncate at 150 lines to prevent context overload
        const truncated = content.split("\n").slice(0, 150).join("\n");
        fileContentParts.push(`--- FILE: ${shortName}/${candidatePath} ---\n${truncated}`);
      }
    }
  }

  // Target repo structure (the last repo is the "common" target by convention)
  const targetStructure = structures[structures.length - 1];

  const lessonsSection = priorLessons.length > 0
    ? `PRIOR LESSONS FROM THIS REPO:\n${priorLessons.map((l, i) => `${i + 1}. ${l}`).join("\n")}\n\n`
    : "";

  const prompt = `You are a senior ${language} architect.
GOAL: ${goal}

${lessonsSection}CANDIDATE FILES (contents — decide what to move):
${fileContentParts.join("\n\n")}

TARGET REPO STRUCTURE (${targetStructure.ownerRepo}):
${targetStructure.tree}

REPO SHORT NAMES: ${structures.map((s, i) => `REPO ${i + 1} = "${repoShortName(s.ownerRepo)}"`).join(", ")}

Based on the goal and file contents, output a refactor plan. Use only the short repo names (without owner) in all fields.

Respond ONLY with valid JSON (no markdown, no extra text):
{
  "filesToMove": [
    {
      "fromRepo": "<short name>",
      "path": "src/shared/utils/server_time.ts",
      "toRepo": "<short name>",
      "targetPath": "packages/utils/src/server_time.ts",
      "reason": "..."
    }
  ],
  "importsToUpdate": [
    {
      "repo": "<short name>",
      "file": "src/...",
      "oldImport": "...",
      "newImport": "..."
    }
  ],
  "versionBumps": [
    {
      "repo": "<short name>",
      "packagePath": "packages/utils/package.json",
      "field": "version",
      "newValue": "0.3.0"
    }
  ],
  "summary": "..."
}`;

  const raw = await generate(
    prompt,
    { model: "qwen3:14b", num_ctx: 24576, num_predict: 4096 },
    "refactor_pass2"
  );

  return parseJsonSafe<RefactorPlan>(raw, fallback);
}

// ─── Verification step ────────────────────────────────────────────────────────

/**
 * After executing the plan, re-read modified files and ask the model
 * if they look correct. Log warnings if issues found.
 */
async function verifyModifiedFiles(
  modifiedFiles: Array<{ repoDir: string; path: string; repoName: string }>,
  goal: string,
  language: string
): Promise<string[]> {
  if (modifiedFiles.length === 0) return [];

  log("\n🔎 Verification: checking modified files...");

  const issues: string[] = [];

  for (const { repoDir, path, repoName } of modifiedFiles) {
    const content = await readRepoFile(repoDir, path);
    if (!content) {
      log(`  ⚠️  Could not re-read ${repoName}/${path} for verification`);
      continue;
    }

    const truncated = content.split("\n").slice(0, 100).join("\n");
    const verifyPrompt = `You are reviewing a ${language} file after a refactor.
GOAL: ${goal}
FILE: ${repoName}/${path}

${truncated}

Does this file look correct after the refactor? Any obvious issues (broken imports, wrong paths, missing exports, syntax errors)?
Reply with a brief assessment. If there are issues, start your reply with "ISSUE:". If it looks fine, start with "OK:".`;

    const raw = await generate(
      verifyPrompt,
      { model: "qwen3:14b", num_ctx: 8192, num_predict: 256 },
      "refactor_verify"
    );

    const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (stripped.startsWith("ISSUE:")) {
      log(`  ⚠️  ${repoName}/${path}: ${stripped}`);
      issues.push(`${repoName}/${path}: ${stripped.slice("ISSUE:".length).trim()}`);
    } else {
      log(`  ✅ ${repoName}/${path}: ${stripped.slice(0, 100)}`);
    }
  }

  return issues;
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

// ─── Speculative Execution ────────────────────────────────────────────────────

interface BranchVariant {
  variant: "v1" | "v2" | "v3";
  branchName: string;
  skipImports: boolean;
  applyVersionBumps: boolean;
}

interface BranchResult {
  variant: "v1" | "v2" | "v3";
  branchName: string;
  score: number;
  tscErrors: number;
  tscOutput: string;
  reposWithChanges: Set<string>;
  modifiedFiles: Array<{ repoDir: string; path: string; repoName: string }>;
  movedCount: number;
  importUpdateCount: number;
}

/** Execute a single variant of the refactor plan on a set of cloned dirs */
async function executePlanVariant(
  variant: BranchVariant,
  plan: RefactorPlan,
  clonedDirs: Map<string, string>,
  resolveRepo: (nameOrOwner: string) => string | undefined,
  language: string,
  goal: string
): Promise<BranchResult> {
  const result: BranchResult = {
    variant: variant.variant,
    branchName: variant.branchName,
    score: 0,
    tscErrors: -1,
    tscOutput: "",
    reposWithChanges: new Set(),
    modifiedFiles: [],
    movedCount: 0,
    importUpdateCount: 0,
  };

  // Determine which repos have changes
  for (const move of plan.filesToMove) {
    const fromRepo = resolveRepo(move.fromRepo);
    const toRepo = resolveRepo(move.toRepo);
    if (fromRepo) result.reposWithChanges.add(fromRepo);
    if (toRepo) result.reposWithChanges.add(toRepo);
  }
  if (!variant.skipImports) {
    for (const imp of plan.importsToUpdate) {
      const repo = resolveRepo(imp.repo);
      if (repo) result.reposWithChanges.add(repo);
    }
  }
  if (variant.applyVersionBumps) {
    for (const bump of plan.versionBumps) {
      const repo = resolveRepo(bump.repo);
      if (repo) result.reposWithChanges.add(repo);
    }
  }

  // Create branches
  for (const repo of result.reposWithChanges) {
    const dir = clonedDirs.get(repo)!;
    await createBranch(dir, variant.branchName);
  }

  // Execute file moves
  for (const move of plan.filesToMove) {
    const fromRepo = resolveRepo(move.fromRepo);
    const toRepo = resolveRepo(move.toRepo);
    if (!fromRepo || !toRepo) continue;

    const fromDir = clonedDirs.get(fromRepo)!;
    const toDir = clonedDirs.get(toRepo)!;
    const content = await readRepoFile(fromDir, move.path);
    if (!content) continue;

    await writeRepoFile(toDir, move.targetPath, content);
    result.modifiedFiles.push({ repoDir: toDir, path: move.targetPath, repoName: repoShortName(toRepo) });
    if (fromRepo !== toRepo) await deleteRepoFile(fromDir, move.path);
    result.movedCount++;
  }

  // Update imports (unless conservative/skipImports)
  if (!variant.skipImports) {
    for (const imp of plan.importsToUpdate) {
      const repo = resolveRepo(imp.repo);
      if (!repo) continue;
      const dir = clonedDirs.get(repo)!;
      const content = await readRepoFile(dir, imp.file);
      if (!content) continue;
      if (content.includes(imp.oldImport)) {
        const updated = content.split(imp.oldImport).join(imp.newImport);
        await writeRepoFile(dir, imp.file, updated);
        result.modifiedFiles.push({ repoDir: dir, path: imp.file, repoName: repoShortName(repo) });
        result.importUpdateCount++;
      }
    }
  }

  // Apply version bumps (v3 only)
  if (variant.applyVersionBumps) {
    for (const bump of plan.versionBumps) {
      const repo = resolveRepo(bump.repo);
      if (!repo) continue;
      const dir = clonedDirs.get(repo)!;
      const content = await readRepoFile(dir, bump.packagePath);
      if (!content) continue;
      try {
        const pkg = JSON.parse(content) as Record<string, unknown>;
        pkg[bump.field] = bump.newValue;
        await writeRepoFile(dir, bump.packagePath, JSON.stringify(pkg, null, 2) + "\n");
      } catch { /* ignore */ }
    }
  }

  // Run tsc in each affected repo dir to score
  try {
    if (runTsc) {
      let totalErrors = 0;
      const tscLines: string[] = [];
      for (const repo of result.reposWithChanges) {
        const dir = clonedDirs.get(repo)!;
        const tscResult = await runTsc(dir);
        totalErrors += tscResult.errorCount;
        tscLines.push(...tscResult.errors.map((e) => `${e.file}:${e.line}:${e.col} - ${e.message}`));
      }
      result.tscErrors = totalErrors;
      result.tscOutput = tscLines.join("\n");
      // Score: 2 pts if all pass, 1 pt if partial (<5 errors), 0 if more
      if (totalErrors === 0) result.score = 2;
      else if (totalErrors < 5) result.score = 1;
      else result.score = 0;
    } else {
      // No tsc available — default to 1 (neutral, not penalized)
      result.score = 1;
      result.tscErrors = 0;
    }
  } catch (err) {
    log(`  ⚠️  tsc check failed for ${variant.variant}: ${err instanceof Error ? err.message : String(err)}`);
    result.score = 0;
    result.tscErrors = 999;
  }

  return result;
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export async function runRefactor(opts: RefactorOptions): Promise<void> {
  const { repos, goal, language = "TypeScript", verbose = false } = opts;
  const shouldOpenPR = opts.openPR !== false; // default true
  const timestamp = Date.now();

  if (repos.length < 2) {
    throw new Error("refactor requires at least 2 repos (--repos owner/repo1 owner/repo2)");
  }

  // ── Maps for deterministic repo lookup (short name → full ownerRepo) ────────
  const shortNameMap = new Map<string, string>(); // "Anime-Reborn-Lobby" → "King-Studios-RBX/Anime-Reborn-Lobby"
  const clonedDirs = new Map<string, string>();   // ownerRepo → local cloned dir

  for (const repo of repos) {
    shortNameMap.set(repoShortName(repo), repo);
  }

  // ── Helper: resolve ownerRepo from short or full name ──────────────────────
  function resolveRepo(nameOrOwner: string): string | undefined {
    if (clonedDirs.has(nameOrOwner)) return nameOrOwner;
    const full = shortNameMap.get(nameOrOwner);
    if (full) return full;
    for (const [short, full] of shortNameMap) {
      if (short.includes(nameOrOwner) || nameOrOwner.includes(short)) return full;
    }
    return undefined;
  }

  // ── Step 0: Load prior refactor lessons from memory ────────────────────────
  log("\n🧠 Step 0: Loading prior refactor lessons from memory...");
  const allPriorLessons: string[] = [];
  for (const repo of repos) {
    try {
      const lessons = await getRefactorLessons(repo, goal, 5);
      if (lessons.length > 0) {
        log(`  📚 ${repo}: ${lessons.length} prior lesson(s) found`);
        allPriorLessons.push(...lessons.map((l) => `[${repo}] ${l}`));
      }
    } catch (err) {
      log(`  ⚠️  Could not load lessons for ${repo}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Step 1: Clone repos ────────────────────────────────────────────────────
  log("\n🔁 Step 1: Cloning repos...");

  for (const repo of repos) {
    const name = repoShortName(repo);
    const dest = `/tmp/arkos-refactor/${name}-${timestamp}`;
    log(`  📦 Cloning ${repo}...`);
    const dir = await cloneRepo(repo, dest);
    clonedDirs.set(repo, dir);
    log(`  ✅ Cloned ${repo} → ${dir}`);
  }

  // ── Step 2: Read structures + build repo maps ──────────────────────────────
  log("\n📂 Step 2: Reading repo structures & building repo maps...");
  const structures: RepoStructure[] = [];
  const repoMaps: RepoMap[] = [];

  for (const repo of repos) {
    const dir = clonedDirs.get(repo)!;
    const structure = await readRepoStructure(dir, repo);
    structures.push(structure);
    log(`  📄 ${repo}: ${structure.files.length} files`);

    const repoMap = await buildRepoMap(dir);
    repoMaps.push(repoMap);
    log(`  🗺️  ${repo}: ${repoMap.files.length} source files mapped`);
  }

  // ── Step 3a: Pass 1 — identify candidate files (no raw content) ──────────
  log("\n🔍 Step 3a: Pass 1 — identifying candidate files (map-only)...");
  const candidates = await identifyCandidates(structures, repoMaps, goal, language);

  if (candidates.length === 0) {
    log("\n⚠️  Pass 1 found no candidate files. Refactor complete (nothing to do).");
    return;
  }

  // ── Step 3b: Pass 2 — full plan with candidate contents + prior lessons ───
  log(`\n🔍 Step 3b: Pass 2 — deep analysis of ${candidates.length} candidate files...`);
  if (allPriorLessons.length > 0) {
    log(`  💡 Injecting ${allPriorLessons.length} prior lesson(s) into prompt`);
  }
  const plan = await buildRefactorPlan(
    structures,
    candidates,
    goal,
    language,
    shortNameMap,
    clonedDirs,
    allPriorLessons
  );

  if (verbose) log(`\n[PLAN]\n${JSON.stringify(plan, null, 2)}\n`);

  // ── Step 4: Plan review ────────────────────────────────────────────────────
  log("\n📋 Step 4: Reviewing plan...");
  log(`  Files to move:     ${plan.filesToMove.length}`);
  log(`  Imports to update: ${plan.importsToUpdate.length}`);
  log(`  Version bumps:     ${plan.versionBumps.length}`);
  log(`  Summary: ${plan.summary}`);

  if (plan.filesToMove.length === 0) {
    log("\n⚠️  No files identified to move. Refactor complete (nothing to do).");
    return;
  }

  // ── Step 5: Speculative execution — 3 parallel branches ───────────────────
  log("\n🔀 Step 5: Speculative execution — running 3 branch variants...");

  // We need separate clonedDirs for each variant (clone again into variant-specific dirs)
  // For simplicity, we create variant copies by cloning fresh for each — or reuse with temp dirs.
  // Strategy: clone 3 separate copies (v1, v2, v3) from the first clone via cp.
  const { exec: cpExec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(cpExec);

  const variants: BranchVariant[] = [
    { variant: "v1", branchName: `arkos/refactor-${timestamp}-v1`, skipImports: false, applyVersionBumps: false },
    { variant: "v2", branchName: `arkos/refactor-${timestamp}-v2`, skipImports: true,  applyVersionBumps: false },
    { variant: "v3", branchName: `arkos/refactor-${timestamp}-v3`, skipImports: false, applyVersionBumps: true  },
  ];

  // Build variant-specific clonedDirs maps by copying the original clones
  const variantClonedDirs: Map<"v1" | "v2" | "v3", Map<string, string>> = new Map();
  for (const variant of variants) {
    const vDirs = new Map<string, string>();
    for (const [repo, originalDir] of clonedDirs) {
      const vDir = `${originalDir}-${variant.variant}`;
      try {
        await execAsync(`cp -r ${originalDir} ${vDir}`);
        vDirs.set(repo, vDir);
      } catch (err) {
        log(`  ⚠️  Could not copy ${repo} for ${variant.variant}: ${err instanceof Error ? err.message : String(err)}`);
        vDirs.set(repo, originalDir); // fall back
      }
    }
    variantClonedDirs.set(variant.variant, vDirs);
  }

  // Execute all 3 variants (in parallel)
  log("  🏃 Executing v1 (full plan), v2 (skip imports), v3 (full plan + pkg version bump)...");
  const branchResults = await Promise.all(
    variants.map(async (variant) => {
      const vDirs = variantClonedDirs.get(variant.variant)!;
      function resolveRepoVariant(nameOrOwner: string): string | undefined {
        if (vDirs.has(nameOrOwner)) return nameOrOwner;
        const full = shortNameMap.get(nameOrOwner);
        if (full) return full;
        for (const [short, full] of shortNameMap) {
          if (short.includes(nameOrOwner) || nameOrOwner.includes(short)) return full;
        }
        return undefined;
      }
      try {
        return await executePlanVariant(variant, plan, vDirs, resolveRepoVariant, language, goal);
      } catch (err) {
        log(`  ⚠️  Variant ${variant.variant} failed: ${err instanceof Error ? err.message : String(err)}`);
        return {
          variant: variant.variant,
          branchName: variant.branchName,
          score: 0,
          tscErrors: 999,
          tscOutput: String(err),
          reposWithChanges: new Set<string>(),
          modifiedFiles: [],
          movedCount: 0,
          importUpdateCount: 0,
        } as BranchResult;
      }
    })
  );

  // ── Step 5b: Score and pick winner ─────────────────────────────────────────
  branchResults.sort((a, b) => b.score - a.score);
  const winner = branchResults[0];

  log("\n🏆 Branch scoring results:");
  for (const r of branchResults) {
    const isWinner = r.variant === winner.variant;
    const tscLabel = r.tscErrors === -1
      ? "tsc not available"
      : r.tscErrors === 0
        ? "tsc passed"
        : `tsc: ${r.tscErrors} error${r.tscErrors !== 1 ? "s" : ""}`;
    const prefix = isWinner ? "🏆 Best branch" : "  ";
    log(`${prefix}: ${r.variant} (score: ${r.score}/2 — ${tscLabel})`);
  }

  log(`\n✅ Winner: ${winner.variant} (score ${winner.score}/2)`);

  // ── Step 5c: Verify winner's modified files ────────────────────────────────
  const vDirsWinner = variantClonedDirs.get(winner.variant)!;
  // Remap modifiedFiles to use winner's dirs
  const verifyIssues = await verifyModifiedFiles(winner.modifiedFiles, goal, language);

  // ── Store lessons learned ──────────────────────────────────────────────────
  for (const repo of repos) {
    for (const issue of verifyIssues) {
      try {
        await storeRefactorLesson(repo, issue);
      } catch { /* best-effort */ }
    }
    // Also store a summary lesson
    try {
      const scoreLabel = winner.score === 2 ? "tsc passed" : winner.score === 1 ? "partial tsc" : "tsc failed";
      await storeRefactorLesson(repo, `Refactor "${goal.slice(0, 60)}": winner ${winner.variant} score ${winner.score}/2 — ${scoreLabel}`);
    } catch { /* best-effort */ }
  }

  // ── Step 6: Create PRs from winning branch ─────────────────────────────────
  const prUrls: string[] = [];

  if (shouldOpenPR) {
    log(`\n🚀 Step 6: Creating PRs from winning branch (${winner.variant})...`);

    for (const repo of winner.reposWithChanges) {
      const dir = vDirsWinner.get(repo)!;

      const repoMoves = plan.filesToMove.filter(
        (m) => {
          const fr = (() => {
            if (vDirsWinner.has(m.fromRepo)) return m.fromRepo;
            return shortNameMap.get(m.fromRepo) ?? m.fromRepo;
          })();
          const tr = (() => {
            if (vDirsWinner.has(m.toRepo)) return m.toRepo;
            return shortNameMap.get(m.toRepo) ?? m.toRepo;
          })();
          return fr === repo || tr === repo;
        }
      );
      const repoImports = plan.importsToUpdate.filter((i) => {
        const r = shortNameMap.get(i.repo) ?? i.repo;
        return r === repo;
      });
      const repoBumps = plan.versionBumps.filter((b) => {
        const r = shortNameMap.get(b.repo) ?? b.repo;
        return r === repo;
      });

      const scoreSummary = branchResults
        .map((r) => {
          const tscLabel = r.tscErrors === 0 ? "tsc passed" : r.tscErrors < 0 ? "tsc unavailable" : `${r.tscErrors} error${r.tscErrors !== 1 ? "s" : ""}`;
          return `- ${r.variant}: ${r.score}/2 (${tscLabel})`;
        })
        .join("\n");

      const prBody = `## Arkos Refactor

**Goal:** ${goal}

**Summary:** ${plan.summary}

**Speculative Execution:** Best branch is \`${winner.variant}\` (score: ${winner.score}/2)
\`\`\`
${scoreSummary}
\`\`\`

### Changes
${repoMoves.length > 0 ? `\n**File moves:**\n${repoMoves.map((m) => `- \`${m.path}\` → \`${m.targetPath}\` (${m.reason})`).join("\n")}` : ""}
${repoImports.length > 0 ? `\n**Import updates:**\n${repoImports.map((i) => `- \`${i.file}\`: \`${i.oldImport}\` → \`${i.newImport}\``).join("\n")}` : ""}
${repoBumps.length > 0 ? `\n**Version bumps:**\n${repoBumps.map((b) => `- \`${b.packagePath}\`: ${b.field} = ${b.newValue}`).join("\n")}` : ""}

*Generated by [Arkos](https://github.com/King-Studios-RBX/arkos) refactor pipeline*`;

      try {
        await commitAll(dir, `refactor: ${plan.summary}`);
        await pushBranch(dir, winner.branchName);
        const prUrl = await openPR(dir, `refactor: ${plan.summary}`, prBody);
        prUrls.push(prUrl);
        log(`  ✅ PR opened: ${prUrl}`);
      } catch (err) {
        log(
          `  ⚠️  Could not open PR for ${repo}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  } else {
    log(`\n⏭️  Step 6: Skipped (--no-pr)`);
    log(`  Changes are in branch ${winner.branchName} in:`);
    for (const repo of winner.reposWithChanges) {
      const dir = vDirsWinner.get(repo)!;
      try {
        await commitAll(dir, `refactor: ${plan.summary}`);
        log(`    ✅ ${repo} → ${dir}`);
      } catch (err) {
        log(`    ⚠️  Commit failed for ${repo}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Step 7: Report ─────────────────────────────────────────────────────────
  log("\n✅ Refactor complete");
  log(`  Winner: ${winner.variant} (score: ${winner.score}/2)`);
  log(`  Moved ${winner.movedCount} file${winner.movedCount !== 1 ? "s" : ""}`);
  log(`  Updated ${winner.importUpdateCount} import path${winner.importUpdateCount !== 1 ? "s" : ""}`);
  if (prUrls.length > 0) {
    log("  PRs opened:");
    for (const url of prUrls) {
      log(`    ${url}`);
    }
  }
}
