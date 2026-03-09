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
    { model: "qwen3:14b", num_ctx: 16384, num_predict: 1024 },
    "refactor_pass1"
  );

  const result = parseJsonSafe<CandidateList>(raw, { candidates: [] });

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

export async function runRefactor(opts: RefactorOptions): Promise<void> {
  const { repos, goal, language = "TypeScript", verbose = false } = opts;
  const shouldOpenPR = opts.openPR !== false; // default true
  const timestamp = Date.now();
  const branchName = `arkos/refactor-${timestamp}`;

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
    // Exact match (full ownerRepo)
    if (clonedDirs.has(nameOrOwner)) return nameOrOwner;
    // Short name match
    const full = shortNameMap.get(nameOrOwner);
    if (full) return full;
    // Fuzzy: find any repo whose short name contains nameOrOwner
    for (const [short, full] of shortNameMap) {
      if (short.includes(nameOrOwner) || nameOrOwner.includes(short)) return full;
    }
    return undefined;
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

  // ── Step 3b: Pass 2 — full plan with candidate contents ───────────────────
  log(`\n🔍 Step 3b: Pass 2 — deep analysis of ${candidates.length} candidate files...`);
  const plan = await buildRefactorPlan(
    structures,
    candidates,
    goal,
    language,
    shortNameMap,
    clonedDirs
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

  // ── Step 5: Execute ────────────────────────────────────────────────────────
  log("\n⚙️  Step 5: Executing plan...");

  // Determine which repos have changes
  const reposWithChanges = new Set<string>();
  for (const move of plan.filesToMove) {
    const fromRepo = resolveRepo(move.fromRepo);
    const toRepo = resolveRepo(move.toRepo);
    if (fromRepo) reposWithChanges.add(fromRepo);
    if (toRepo) reposWithChanges.add(toRepo);
  }
  for (const imp of plan.importsToUpdate) {
    const repo = resolveRepo(imp.repo);
    if (repo) reposWithChanges.add(repo);
  }
  for (const bump of plan.versionBumps) {
    const repo = resolveRepo(bump.repo);
    if (repo) reposWithChanges.add(repo);
  }

  // Create branches in repos with changes
  for (const repo of reposWithChanges) {
    const dir = clonedDirs.get(repo)!;
    log(`  🌿 Creating branch ${branchName} in ${repo}...`);
    await createBranch(dir, branchName);
  }

  // Track modified files for verification
  const modifiedFiles: Array<{ repoDir: string; path: string; repoName: string }> = [];

  // Execute file moves
  let movedCount = 0;
  for (const move of plan.filesToMove) {
    const fromRepo = resolveRepo(move.fromRepo);
    const toRepo = resolveRepo(move.toRepo);

    if (!fromRepo || !toRepo) {
      log(`  ⚠️  Could not find repos for move: ${move.fromRepo} → ${move.toRepo}, skipping`);
      continue;
    }

    const fromDir = clonedDirs.get(fromRepo)!;
    const toDir = clonedDirs.get(toRepo)!;

    log(`  📁 Moving ${move.path} (${repoShortName(fromRepo)} → ${repoShortName(toRepo)})`);

    const content = await readRepoFile(fromDir, move.path);
    if (!content) {
      log(`  ⚠️  Source file not found: ${move.path}, skipping`);
      continue;
    }

    await writeRepoFile(toDir, move.targetPath, content);
    modifiedFiles.push({ repoDir: toDir, path: move.targetPath, repoName: repoShortName(toRepo) });

    if (fromRepo !== toRepo) {
      await deleteRepoFile(fromDir, move.path);
    }
    movedCount++;
  }

  // Update imports
  let importUpdateCount = 0;
  for (const imp of plan.importsToUpdate) {
    const repo = resolveRepo(imp.repo);
    if (!repo) continue;

    const dir = clonedDirs.get(repo)!;
    const content = await readRepoFile(dir, imp.file);
    if (!content) continue;

    if (content.includes(imp.oldImport)) {
      const updated = content.split(imp.oldImport).join(imp.newImport);
      await writeRepoFile(dir, imp.file, updated);
      modifiedFiles.push({ repoDir: dir, path: imp.file, repoName: repoShortName(repo) });
      log(`  🔗 Updated import in ${imp.file}: "${imp.oldImport}" → "${imp.newImport}"`);
      importUpdateCount++;
    }
  }

  // Apply version bumps
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
      log(`  📦 Version bump in ${bump.packagePath}: ${bump.field} = ${bump.newValue}`);
    } catch {
      log(`  ⚠️  Could not parse ${bump.packagePath} for version bump`);
    }
  }

  // ── Step 5b: Verification ──────────────────────────────────────────────────
  await verifyModifiedFiles(modifiedFiles, goal, language);

  // ── Step 6: Create PRs ─────────────────────────────────────────────────────
  const prUrls: string[] = [];

  if (shouldOpenPR) {
    log("\n🚀 Step 6: Creating PRs...");

    for (const repo of reposWithChanges) {
      const dir = clonedDirs.get(repo)!;
      const shortName = repoShortName(repo);

      const repoMoves = plan.filesToMove.filter(
        (m) => resolveRepo(m.fromRepo) === repo || resolveRepo(m.toRepo) === repo
      );
      const repoImports = plan.importsToUpdate.filter(
        (i) => resolveRepo(i.repo) === repo
      );
      const repoBumps = plan.versionBumps.filter(
        (b) => resolveRepo(b.repo) === repo
      );

      const prBody = `## Arkos Refactor

**Goal:** ${goal}

**Summary:** ${plan.summary}

### Changes
${repoMoves.length > 0 ? `\n**File moves:**\n${repoMoves.map((m) => `- \`${m.path}\` → \`${m.targetPath}\` (${m.reason})`).join("\n")}` : ""}
${repoImports.length > 0 ? `\n**Import updates:**\n${repoImports.map((i) => `- \`${i.file}\`: \`${i.oldImport}\` → \`${i.newImport}\``).join("\n")}` : ""}
${repoBumps.length > 0 ? `\n**Version bumps:**\n${repoBumps.map((b) => `- \`${b.packagePath}\`: ${b.field} = ${b.newValue}`).join("\n")}` : ""}

*Generated by [Arkos](https://github.com/King-Studios-RBX/arkos) refactor pipeline*`;

      try {
        await commitAll(dir, `refactor: ${plan.summary}`);
        await pushBranch(dir, branchName);
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
    log("\n⏭️  Step 6: Skipped (--no-pr)");
    log("  Changes committed to branches in:");
    for (const repo of reposWithChanges) {
      const dir = clonedDirs.get(repo)!;
      try {
        await commitAll(dir, `refactor: ${plan.summary}`);
        log(`    ✅ ${repo} → ${dir} (branch: ${branchName})`);
      } catch (err) {
        log(`    ⚠️  Commit failed for ${repo}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Step 7: Report ─────────────────────────────────────────────────────────
  log("\n✅ Refactor complete");
  log(`  Moved ${movedCount} file${movedCount !== 1 ? "s" : ""}`);
  log(`  Updated ${importUpdateCount} import path${importUpdateCount !== 1 ? "s" : ""}`);
  if (prUrls.length > 0) {
    log("  PRs opened:");
    for (const url of prUrls) {
      log(`    ${url}`);
    }
  }
}
