// ─── Repo Reader ──────────────────────────────────────────────────────────────
// Read repo structure and file contents for LLM consumption

import { readdir, readFile, writeFile, unlink, mkdir, stat } from "fs/promises";
import { join, relative, dirname, extname } from "path";

export interface FileEntry {
  path: string;    // relative to repo root
  content: string; // file contents
  size: number;
}

export interface RepoStructure {
  ownerRepo: string;
  localDir: string;
  files: FileEntry[];                         // all non-ignored source files
  packageJson?: Record<string, unknown>;
  tree: string;                               // formatted file tree string
}

const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".turbo",
  "out",
  "build",
  ".next",
  ".cache",
  "coverage",
]);

const IGNORE_EXTENSIONS = new Set([
  ".lock",
  ".tsbuildinfo",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".pdf",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".dat",
]);

const MAX_FILE_SIZE = 50 * 1024; // 50KB

function isIgnored(filePath: string): boolean {
  const parts = filePath.split("/");
  for (const part of parts) {
    if (IGNORE_DIRS.has(part)) return true;
  }
  const ext = extname(filePath);
  if (IGNORE_EXTENSIONS.has(ext)) return true;
  // Also ignore .lock files with multi-part extensions (e.g. yarn.lock)
  if (filePath.endsWith(".lock")) return true;
  if (filePath.endsWith(".tsbuildinfo")) return true;
  return false;
}

async function walkDir(dir: string, baseDir: string): Promise<FileEntry[]> {
  const results: FileEntry[] = [];
  let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[];

  try {
    const dirEntries = await readdir(dir, { withFileTypes: true });
    entries = dirEntries;
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(baseDir, fullPath).replace(/\\/g, "/");

    if (isIgnored(relPath)) continue;

    if (entry.isDirectory()) {
      const sub = await walkDir(fullPath, baseDir);
      results.push(...sub);
    } else if (entry.isFile()) {
      try {
        const fileStat = await stat(fullPath);
        if (fileStat.size > MAX_FILE_SIZE) continue;

        const buffer = await readFile(fullPath);
        // Skip binary files (check for null bytes in first 512 bytes)
        if (buffer.slice(0, 512).includes(0)) continue;

        const content = buffer.toString("utf-8");
        results.push({ path: relPath, content, size: fileStat.size });
      } catch {
        // Unreadable file — skip
      }
    }
  }

  return results;
}

/**
 * Read a repo's full structure — file tree + contents of all source files.
 * Ignores: node_modules, dist, .git, *.lock, *.tsbuildinfo, binaries.
 */
export async function readRepoStructure(
  localDir: string,
  ownerRepo: string
): Promise<RepoStructure> {
  const files = await walkDir(localDir, localDir);

  // Try to load package.json
  let packageJson: Record<string, unknown> | undefined;
  const pkgEntry = files.find((f) => f.path === "package.json");
  if (pkgEntry) {
    try {
      packageJson = JSON.parse(pkgEntry.content) as Record<string, unknown>;
    } catch {
      // ignore parse errors
    }
  }

  const tree = formatTree(files);

  return { ownerRepo, localDir, files, packageJson, tree };
}

/**
 * Format a file tree for LLM consumption (like `tree` command output).
 */
export function formatTree(files: FileEntry[]): string {
  // Build a nested structure from flat paths
  const tree: Record<string, unknown> = {};

  for (const file of files) {
    const parts = file.path.split("/");
    let node: Record<string, unknown> = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!node[part]) node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = null; // leaf = file
  }

  function render(
    node: Record<string, unknown>,
    prefix = "",
    isLast = true
  ): string {
    const lines: string[] = [];
    const keys = Object.keys(node).sort((a, b) => {
      // Dirs before files
      const aIsDir = node[a] !== null;
      const bIsDir = node[b] !== null;
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.localeCompare(b);
    });

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const isLastItem = i === keys.length - 1;
      const connector = isLastItem ? "└── " : "├── ";
      const childPrefix = prefix + (isLastItem ? "    " : "│   ");

      if (node[key] === null) {
        // File
        lines.push(prefix + connector + key);
      } else {
        // Directory
        lines.push(prefix + connector + key + "/");
        lines.push(render(node[key] as Record<string, unknown>, childPrefix, isLastItem));
      }
    }
    return lines.filter(Boolean).join("\n");
  }

  return render(tree);
}

/**
 * Read a single file relative to the repo root. Returns null if not found.
 */
export async function readRepoFile(
  repoDir: string,
  relativePath: string
): Promise<string | null> {
  try {
    const fullPath = join(repoDir, relativePath);
    const content = await readFile(fullPath, "utf-8");
    return content;
  } catch {
    return null;
  }
}

/**
 * Write a file (creates parent directories as needed).
 */
export async function writeRepoFile(
  repoDir: string,
  relativePath: string,
  content: string
): Promise<void> {
  const fullPath = join(repoDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

/**
 * Delete a file in the repo.
 */
export async function deleteRepoFile(
  repoDir: string,
  relativePath: string
): Promise<void> {
  const fullPath = join(repoDir, relativePath);
  await unlink(fullPath);
}
