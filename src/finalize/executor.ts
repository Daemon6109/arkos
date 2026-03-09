// ─── Finalize Executor ────────────────────────────────────────────────────────
// Processes import_cleanup todos from ~/.arkos/finalize-todo.json:
// clones target repo, rewrites imports, deletes duplicate local files,
// validates with tsc, then commits + opens a PR.

import { exec } from "child_process";
import { promisify } from "util";
import { readFile, readdir } from "fs/promises";
import { join, basename, extname } from "path";
import { homedir } from "os";

import type { TodoItem, TodoType } from "./types.js";
import { cloneRepo, createBranch, commitAll, pushBranch, openPR } from "../tools/git.js";
import { writeRepoFile, deleteRepoFile } from "../tools/repo_reader.js";
import { runTsc } from "../tools/tsc_checker.js";

const execAsync = promisify(exec);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExecutorOptions {
  targetRepo: string;
  todoFile?: string;    // default ~/.arkos/finalize-todo.json
  types?: TodoType[];   // which todo types to process (default: ["import_cleanup"])
  dryRun?: boolean;     // log what would happen, don't write files
  noPR?: boolean;       // don't open PRs
  maxItems?: number;    // process at most N items
}

// ─── Local import scanner ─────────────────────────────────────────────────────

/**
 * Walk all TS/JS files in repoDir and find those that import the moved file
 * (matched by basename, since imports can be relative or alias-based).
 */
async function scanImportsForFile(
  repoDir: string,
  movedPath: string
): Promise<Array<{ file: string; matchedImport: string }>> {
  const results: Array<{ file: string; matchedImport: string }> = [];
  const baseName = movedPath.replace(/\.[jt]sx?$/, "").split("/").pop() ?? "";
  if (!baseName) return results;

  async function walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) files.push(...(await walk(full)));
      else if (/\.[jt]sx?$/.test(e.name)) files.push(full);
    }
    return files;
  }

  const allFiles = await walk(repoDir);
  const importRegex = new RegExp(
    `from\\s+['"]([^'"]*/${baseName})['"]|require\\(['"]([^'"]*/${baseName})['"]\\)`,
    "g"
  );

  for (const filePath of allFiles) {
    const content = await readFile(filePath, "utf8").catch(() => "");
    let match: RegExpExecArray | null;
    importRegex.lastIndex = 0;
    while ((match = importRegex.exec(content)) !== null) {
      const matchedImport = match[1] ?? match[2];
      if (matchedImport) {
        results.push({
          file: filePath.startsWith(repoDir + "/")
            ? filePath.slice(repoDir.length + 1)
            : filePath,
          matchedImport,
        });
      }
    }
  }

  return results;
}

// ─── Package name parser ──────────────────────────────────────────────────────

/**
 * Extract the target npm package name from the suggestedChange string.
 * Looks for patterns like: `import { ... } from "@scope/pkg"` or just `"@scope/pkg"`.
 */
function parsePackageFromSuggested(suggestedChange: string): string | null {
  // Primary: from "..." or from '...'
  const doubleQ = suggestedChange.match(/from\s+"(@[^"]+)"/);
  if (doubleQ) return doubleQ[1] ?? null;

  const singleQ = suggestedChange.match(/from\s+'(@[^']+)'/);
  if (singleQ) return singleQ[1] ?? null;

  // Fallback: any @scope/pkg pattern
  const bare = suggestedChange.match(/(@[a-z0-9-]+\/[a-z0-9-]+)/i);
  if (bare) return bare[1] ?? null;

  return null;
}

// ─── Main executor ────────────────────────────────────────────────────────────

export async function runFinalizeExecutor(opts: ExecutorOptions): Promise<void> {
  const todoFile = opts.todoFile ?? join(homedir(), ".arkos", "finalize-todo.json");
  const types: TodoType[] = opts.types ?? ["import_cleanup"];

  // 1. Read todo file
  let report: { items: TodoItem[] };
  try {
    const raw = await readFile(todoFile, "utf-8");
    report = JSON.parse(raw) as { items: TodoItem[] };
  } catch (err) {
    throw new Error(`Failed to read todo file ${todoFile}: ${err}`);
  }

  // 2. Filter items by type (and apply maxItems cap)
  let items = report.items.filter((item) => types.includes(item.type));
  if (opts.maxItems !== undefined && opts.maxItems > 0) {
    items = items.slice(0, opts.maxItems);
  }

  if (items.length === 0) {
    console.log(`ℹ️  No items of type [${types.join(", ")}] found in ${todoFile}`);
    return;
  }

  console.log(`🔧 Finalize Executor — processing ${items.length} ${types.join("/")} item(s)`);
  console.log(`   Target: ${opts.targetRepo}`);
  if (opts.dryRun) console.log("   Mode:   DRY RUN (no files written)");
  console.log("");

  // 3. Clone repo
  const timestamp = Date.now();
  const repoName = opts.targetRepo.split("/")[1] ?? opts.targetRepo.replace("/", "-");
  const cloneDir = `/tmp/arkos-finalize/${repoName}-exec-${timestamp}`;
  const branchName = `arkos/finalize-${timestamp}`;

  if (opts.dryRun) {
    console.log(`[dry-run] Would clone ${opts.targetRepo} → ${cloneDir}`);
    console.log(`[dry-run] Would create branch: ${branchName}`);
    for (const item of items) {
      const pkg = item.suggestedChange ? parsePackageFromSuggested(item.suggestedChange) : null;
      console.log(
        `[dry-run] Would remove ${item.targetFile ?? item.id} → imports → ${pkg ?? "??"}`
      );
    }
    console.log("\n[dry-run] No changes made.");
    return;
  }

  console.log(`📥 Cloning ${opts.targetRepo}...`);
  await cloneRepo(opts.targetRepo, cloneDir);

  // 4. Create branch
  console.log(`🌿 Creating branch: ${branchName}`);
  await createBranch(cloneDir, branchName);

  // 5. Process each item
  const removedFiles: string[] = [];
  const importUpdates: Array<{ file: string; from: string; to: string }> = [];

  for (const item of items) {
    if (!item.targetFile || !item.suggestedChange) {
      console.log(`⚠️  Skipping ${item.id}: missing targetFile or suggestedChange`);
      continue;
    }

    const pkgName = parsePackageFromSuggested(item.suggestedChange);
    if (!pkgName) {
      console.log(`⚠️  Skipping ${item.id}: could not parse package name from suggestedChange`);
      continue;
    }

    // d. Find all files importing this local path
    const matches = await scanImportsForFile(cloneDir, item.targetFile);

    // e. Rewrite imports in each file
    for (const { file, matchedImport } of matches) {
      const fullPath = join(cloneDir, file);
      const content = await readFile(fullPath, "utf-8").catch(() => "");
      if (!content) continue;

      // Escape the matched import path for use in a regex
      const escaped = matchedImport.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const updated = content.replace(
        new RegExp(`(['"])${escaped}(['"])`, "g"),
        `$1${pkgName}$2`
      );

      if (updated !== content) {
        await writeRepoFile(cloneDir, file, updated);
        importUpdates.push({ file, from: matchedImport, to: pkgName });
      }
    }

    // f. Delete the local duplicate file
    await deleteRepoFile(cloneDir, item.targetFile);
    removedFiles.push(item.targetFile);

    // g. Log
    console.log(`  🗑️  Removed ${item.targetFile} → imports updated to ${pkgName}`);
  }

  if (removedFiles.length === 0) {
    console.log(`\nℹ️  No files were removed — nothing to commit.`);
    return;
  }

  // 6. bun install + tsc validation
  // Write .npmrc with GitHub token for private package registry auth
  const githubToken = process.env.GITHUB_TOKEN;
  if (githubToken) {
    const npmrc = `//npm.pkg.github.com/:_authToken=${githubToken}\n@king-studios-rbx:registry=https://npm.pkg.github.com\n`;
    await writeRepoFile(cloneDir, ".npmrc", npmrc);
    console.log(`\n📦 Running bun install (with GitHub Package Registry auth)...`);
  } else {
    console.log(`\n📦 Running bun install (no GITHUB_TOKEN — private packages may fail)...`);
  }
  try {
    await execAsync("bun install", { cwd: cloneDir, timeout: 120_000 });
  } catch (err) {
    console.warn(`⚠️  bun install warning: ${err}`);
  }

  console.log(`🔍 Running tsc validation...`);
  const tscResult = await runTsc(cloneDir);

  // 7. Rollback on tsc failure
  if (!tscResult.success) {
    console.error(`\n❌ TypeScript errors (${tscResult.errorCount}):`);
    for (const e of tscResult.errors.slice(0, 20)) {
      console.error(`   ${e.file}:${e.line}:${e.col} — ${e.message}`);
    }
    if (tscResult.errorCount > 20) {
      console.error(`   ... and ${tscResult.errorCount - 20} more`);
    }
    console.log(`\n🔄 Rolling back changes...`);
    await execAsync("git checkout -- .", { cwd: cloneDir });
    console.log(`❌ PR not opened due to TypeScript errors. Fix the errors and re-run.`);
    return;
  }

  console.log(`✅ TypeScript: no errors`);

  // 8. Commit + push + PR
  const prBody = [
    "## Summary",
    "",
    "Automated import cleanup by **Arkos Finalize Executor**.",
    "Local utility duplicates were removed and their imports updated to use the shared package.",
    "",
    "### Files removed",
    ...removedFiles.map((f) => `- \`${f}\``),
    "",
    `### Imports updated (${importUpdates.length} file${importUpdates.length === 1 ? "" : "s"})`,
    ...importUpdates
      .slice(0, 30)
      .map((u) => `- \`${u.file}\`: \`${u.from}\` → \`${u.to}\``),
    ...(importUpdates.length > 30
      ? [`- ... and ${importUpdates.length - 30} more`]
      : []),
  ].join("\n");

  console.log(`\n💾 Committing changes...`);
  await commitAll(cloneDir, "refactor: remove local utility duplicates, use package imports");

  if (opts.noPR) {
    console.log(`🌿 Pushing branch (--no-pr flag set)...`);
    await pushBranch(cloneDir, branchName);
    console.log(`✅ Branch pushed: ${branchName} (no PR opened)`);
    return;
  }

  console.log(`🚀 Pushing branch and opening PR...`);
  await pushBranch(cloneDir, branchName);
  const prUrl = await openPR(
    cloneDir,
    "refactor: remove local utility duplicates, use package imports",
    prBody
  );
  console.log(`\n✅ PR opened: ${prUrl}`);
}
