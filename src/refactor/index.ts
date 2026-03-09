// ─── Refactor Pipeline ────────────────────────────────────────────────────────
// Cross-repo code analysis and refactoring via LLM-guided moves + PRs

import { cloneRepo, createBranch, commitAll, pushBranch, openPR } from "../tools/git.js";
import {
  readRepoStructure,
  readRepoFile,
  writeRepoFile,
  deleteRepoFile,
  type RepoStructure,
} from "../tools/repo_reader.js";
import { generate, extractJson, parseJsonSafe } from "../ollama.js";

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(msg);
}

/** Build a combined context string showing both repo trees and key file excerpts */
function buildCombinedContext(structures: RepoStructure[]): string {
  const parts: string[] = [];

  structures.forEach((s, i) => {
    const repoLabel = `REPO ${i + 1}: ${s.ownerRepo}`;
    const tree = s.tree;

    // Include first 200 lines of key source files
    const keyFileContents = s.files
      .filter((f) => /\.(ts|tsx|js|jsx|lua|py|go|rs)$/.test(f.path))
      .slice(0, 30) // max 30 files
      .map((f) => {
        const lines = f.content.split("\n").slice(0, 200).join("\n");
        return `--- FILE: ${f.path} ---\n${lines}`;
      })
      .join("\n\n");

    parts.push(`${repoLabel}\n${tree}\n\nKey files:\n${keyFileContents}`);
  });

  return parts.join("\n\n---\n\n");
}

/** Extract the short repo name (without owner) */
function repoName(ownerRepo: string): string {
  return ownerRepo.split("/")[1] ?? ownerRepo;
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

  // ── Step 1: Clone repos ────────────────────────────────────────────────────
  log("\n🔁 Step 1: Cloning repos...");
  const clonedDirs: Record<string, string> = {};

  for (const repo of repos) {
    const name = repoName(repo);
    const dest = `/tmp/arkos-refactor/${name}-${timestamp}`;
    log(`  📦 Cloning ${repo}...`);
    const dir = await cloneRepo(repo, dest);
    clonedDirs[repo] = dir;
    log(`  ✅ Cloned ${repo} → ${dir}`);
  }

  // ── Step 2: Read structures ────────────────────────────────────────────────
  log("\n📂 Step 2: Reading repo structures...");
  const structures: RepoStructure[] = [];

  for (const repo of repos) {
    const dir = clonedDirs[repo];
    const structure = await readRepoStructure(dir, repo);
    structures.push(structure);
    log(`  📄 ${repo}: ${structure.files.length} files`);
  }

  const combinedContext = buildCombinedContext(structures);

  // ── Step 3: Analyze — what should move? ────────────────────────────────────
  log("\n🔍 Step 3: Analyzing repos with LLM...");

  const repoLabels = repos
    .map((r, i) => `REPO ${i + 1} = "${repoName(r)}"`)
    .join(", ");

  const analyzePrompt = `You are a senior ${language}/roblox-ts architect reviewing ${repos.length} repos.

GOAL: ${goal}

Repo mapping: ${repoLabels}

${combinedContext}

Identify files in the repos that:
1. Have no repo-specific dependencies (don't import from local-only modules)
2. Would be useful to share or move between repos (common/shared utilities, types, etc.)
3. Are duplicated or equivalent across repos

Respond ONLY with valid JSON (no markdown fences, no extra text):
{
  "filesToMove": [
    {
      "fromRepo": "<repo name without owner>",
      "path": "src/shared/utils/server_time.ts",
      "toRepo": "<repo name without owner>",
      "targetPath": "packages/utils/src/server_time.ts",
      "reason": "..."
    }
  ],
  "importsToUpdate": [
    {
      "repo": "<repo name without owner>",
      "file": "src/...",
      "oldImport": "...",
      "newImport": "..."
    }
  ],
  "versionBumps": [
    {
      "repo": "<repo name without owner>",
      "packagePath": "packages/utils/package.json",
      "field": "version",
      "newValue": "0.3.0"
    }
  ],
  "summary": "..."
}`;

  if (verbose) log(`\n[ANALYZE PROMPT]\n${analyzePrompt.slice(0, 500)}...\n`);

  const analyzeRaw = await generate(analyzePrompt, { model: "qwen3:14b", num_ctx: 32768 }, "refactor_analyzer");
  const plan = parseJsonSafe<RefactorPlan>(analyzeRaw, {
    filesToMove: [],
    importsToUpdate: [],
    versionBumps: [],
    summary: "No plan generated",
  });

  if (verbose) log(`\n[PLAN]\n${JSON.stringify(plan, null, 2)}\n`);

  // ── Step 4: Plan review ────────────────────────────────────────────────────
  log("\n📋 Step 4: Reviewing plan...");
  log(`  Files to move:    ${plan.filesToMove.length}`);
  log(`  Imports to update: ${plan.importsToUpdate.length}`);
  log(`  Version bumps:     ${plan.versionBumps.length}`);
  log(`  Summary: ${plan.summary}`);

  if (plan.filesToMove.length > 0) {
    const reviewPrompt = `You are reviewing a code refactoring plan.

GOAL: ${goal}

PROPOSED PLAN:
${JSON.stringify(plan, null, 2)}

REPO TREES:
${structures.map((s, i) => `REPO ${i + 1} (${s.ownerRepo}):\n${s.tree}`).join("\n\n")}

Does this plan make sense? Are there any missing import updates or version changes?
If corrections are needed, respond with a corrected JSON plan in the same format.
If the plan is good, respond with the same JSON unchanged.

Respond ONLY with valid JSON:`;

    const reviewRaw = await generate(reviewPrompt, { model: "qwen3:14b", num_ctx: 16384 }, "refactor_planner");
    const reviewed = parseJsonSafe<RefactorPlan>(reviewRaw, plan);

    // Merge reviewed corrections (use reviewed if it has content)
    if (reviewed.filesToMove?.length > 0 || reviewed.importsToUpdate?.length > 0) {
      Object.assign(plan, reviewed);
      log("  ✏️  Plan updated after review");
    } else {
      log("  ✅ Plan validated — no changes needed");
    }
  }

  if (plan.filesToMove.length === 0) {
    log("\n⚠️  No files identified to move. Refactor complete (nothing to do).");
    return;
  }

  // ── Step 5: Execute ────────────────────────────────────────────────────────
  log("\n⚙️  Step 5: Executing plan...");

  // Determine which repos have changes
  const reposWithChanges = new Set<string>();
  for (const move of plan.filesToMove) {
    // Find the ownerRepo matching the short name
    const fromRepo = repos.find((r) => repoName(r) === move.fromRepo || r === move.fromRepo);
    const toRepo = repos.find((r) => repoName(r) === move.toRepo || r === move.toRepo);
    if (fromRepo) reposWithChanges.add(fromRepo);
    if (toRepo) reposWithChanges.add(toRepo);
  }
  for (const imp of plan.importsToUpdate) {
    const repo = repos.find((r) => repoName(r) === imp.repo || r === imp.repo);
    if (repo) reposWithChanges.add(repo);
  }
  for (const bump of plan.versionBumps) {
    const repo = repos.find((r) => repoName(r) === bump.repo || r === bump.repo);
    if (repo) reposWithChanges.add(repo);
  }

  // Create branches in repos with changes
  for (const repo of reposWithChanges) {
    const dir = clonedDirs[repo];
    log(`  🌿 Creating branch ${branchName} in ${repo}...`);
    await createBranch(dir, branchName);
  }

  // Execute file moves
  let movedCount = 0;
  for (const move of plan.filesToMove) {
    const fromRepo = repos.find((r) => repoName(r) === move.fromRepo || r === move.fromRepo);
    const toRepo = repos.find((r) => repoName(r) === move.toRepo || r === move.toRepo);

    if (!fromRepo || !toRepo) {
      log(`  ⚠️  Could not find repos for move: ${move.fromRepo} → ${move.toRepo}, skipping`);
      continue;
    }

    const fromDir = clonedDirs[fromRepo];
    const toDir = clonedDirs[toRepo];

    log(`  📁 Moving ${move.path} (${move.fromRepo} → ${move.toRepo})`);

    const content = await readRepoFile(fromDir, move.path);
    if (!content) {
      log(`  ⚠️  Source file not found: ${move.path}, skipping`);
      continue;
    }

    await writeRepoFile(toDir, move.targetPath, content);
    if (fromRepo !== toRepo) {
      await deleteRepoFile(fromDir, move.path);
    }
    movedCount++;
  }

  // Update imports
  let importUpdateCount = 0;
  for (const imp of plan.importsToUpdate) {
    const repo = repos.find((r) => repoName(r) === imp.repo || r === imp.repo);
    if (!repo) continue;

    const dir = clonedDirs[repo];
    const content = await readRepoFile(dir, imp.file);
    if (!content) continue;

    if (content.includes(imp.oldImport)) {
      const updated = content.split(imp.oldImport).join(imp.newImport);
      await writeRepoFile(dir, imp.file, updated);
      log(`  🔗 Updated import in ${imp.file}: "${imp.oldImport}" → "${imp.newImport}"`);
      importUpdateCount++;
    }
  }

  // Apply version bumps
  for (const bump of plan.versionBumps) {
    const repo = repos.find((r) => repoName(r) === bump.repo || r === bump.repo);
    if (!repo) continue;

    const dir = clonedDirs[repo];
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

  // ── Step 6: Create PRs ─────────────────────────────────────────────────────
  const prUrls: string[] = [];

  if (shouldOpenPR) {
    log("\n🚀 Step 6: Creating PRs...");

    for (const repo of reposWithChanges) {
      const dir = clonedDirs[repo];

      const repoMoves = plan.filesToMove.filter(
        (m) => repoName(m.fromRepo) === repoName(repo) || repoName(m.toRepo) === repoName(repo)
      );
      const repoImports = plan.importsToUpdate.filter(
        (i) => repoName(i.repo) === repoName(repo)
      );
      const repoBumps = plan.versionBumps.filter(
        (b) => repoName(b.repo) === repoName(repo)
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
        const prUrl = await openPR(
          dir,
          `refactor: ${plan.summary}`,
          prBody
        );
        prUrls.push(prUrl);
        log(`  ✅ PR opened: ${prUrl}`);
      } catch (err) {
        log(`  ⚠️  Could not open PR for ${repo}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    log("\n⏭️  Step 6: Skipped (--no-pr)");
    log("  Changes committed to branches in:");
    for (const repo of reposWithChanges) {
      const dir = clonedDirs[repo];
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
