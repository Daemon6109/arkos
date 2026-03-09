// ─── Git Tools ────────────────────────────────────────────────────────────────
// Wrappers around git and gh CLI commands for repo operations

import { exec as cpExec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(cpExec);

const EXEC_TIMEOUT = 60_000; // 60s

async function run(cmd: string, cwd?: string): Promise<string> {
  const { stdout, stderr } = await execAsync(cmd, {
    cwd,
    timeout: EXEC_TIMEOUT,
  });
  if (stderr && !stdout) {
    // Some git commands write useful output to stderr (e.g. clone progress)
    return stderr.trim();
  }
  return stdout.trim();
}

/**
 * Clone a GitHub repo to a target directory, return the local path.
 * If targetDir is not provided, clones to /tmp/arkos-refactor/<repo-name>-<timestamp>.
 */
export async function cloneRepo(ownerRepo: string, targetDir?: string): Promise<string> {
  const repoName = ownerRepo.split("/")[1] ?? ownerRepo.replace("/", "-");
  const dest = targetDir ?? `/tmp/arkos-refactor/${repoName}-${Date.now()}`;
  await run(`git clone https://github.com/${ownerRepo}.git ${dest}`);
  return dest;
}

/**
 * Create and checkout a new branch in the given repo directory.
 */
export async function createBranch(repoDir: string, branchName: string): Promise<void> {
  await run(`git checkout -b ${branchName}`, repoDir);
}

/**
 * Stage all changes and commit with the given message.
 */
export async function commitAll(repoDir: string, message: string): Promise<void> {
  await run(`git add -A`, repoDir);
  await run(`git commit -m ${JSON.stringify(message)}`, repoDir);
}

/**
 * Push a branch to origin.
 */
export async function pushBranch(repoDir: string, branch: string): Promise<void> {
  await run(`git push --set-upstream origin ${branch}`, repoDir);
}

/**
 * Open a GitHub PR via `gh pr create`. Returns the PR URL.
 */
export async function openPR(
  repoDir: string,
  title: string,
  body: string,
  base = "main"
): Promise<string> {
  const cmd = `gh pr create --title ${JSON.stringify(title)} --body ${JSON.stringify(body)} --base ${base}`;
  const output = await run(cmd, repoDir);
  // gh pr create outputs the PR URL as the last line
  const lines = output.split("\n").filter(Boolean);
  return lines[lines.length - 1] ?? output;
}

/**
 * Get the git diff of all staged changes.
 */
export async function getStagedDiff(repoDir: string): Promise<string> {
  return run(`git diff --cached`, repoDir);
}
