// ─── Repo Map ─────────────────────────────────────────────────────────────────
// Compact structural summary of a repo for LLM consumption.
// Uses regex — no AST parse needed.

import { readdir, readFile, stat } from "fs/promises";
import { join, relative, extname } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RepoSymbol {
  name: string;
  kind: "export" | "import" | "type" | "function" | "class" | "const";
  from?: string; // import source module
}

export interface FileMap {
  path: string;
  symbols: RepoSymbol[];
  imports: string[]; // what this file imports from
  exports: string[]; // what this file exports (names only)
}

export interface RepoMap {
  files: FileMap[];
  summary: string; // compact one-liner-per-file representation
}

// ─── Regex patterns ───────────────────────────────────────────────────────────

// Matches: export function Foo, export const Bar, export class Baz,
//          export type X, export interface Y, export default Z
const EXPORT_RE =
  /export\s+(?:default\s+)?(?:async\s+)?(function|const|let|var|class|type|interface|enum)\s+(\w+)/g;

// Matches: export { Foo, Bar } (named re-exports with no 'from' — local exports)
const EXPORT_BRACE_RE = /export\s+\{([^}]+)\}/g;

// Matches: import ... from 'module'
const IMPORT_RE = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;

// ─── Ignored dirs ─────────────────────────────────────────────────────────────

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

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".lua"]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shouldSkipDir(name: string): boolean {
  return IGNORE_DIRS.has(name) || name.startsWith(".");
}

async function walkSourceFiles(dir: string, baseDir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[];
  try {
    const dirEntries = await readdir(dir, { withFileTypes: true });
    entries = dirEntries;
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      const sub = await walkSourceFiles(join(dir, entry.name), baseDir);
      results.push(...sub);
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (SOURCE_EXTS.has(ext)) {
        const fullPath = join(dir, entry.name);
        const relPath = relative(baseDir, fullPath).replace(/\\/g, "/");
        results.push(relPath);
      }
    }
  }
  return results;
}

function parseFileMap(relPath: string, content: string): FileMap {
  const exports: string[] = [];
  const imports: string[] = [];
  const symbols: RepoSymbol[] = [];

  // Extract named exports: export function/const/class/type/interface/enum X
  let m: RegExpExecArray | null;
  const exportRe = new RegExp(EXPORT_RE.source, "g");
  while ((m = exportRe.exec(content)) !== null) {
    const kind = m[1] as RepoSymbol["kind"];
    const name = m[2];
    if (name) {
      exports.push(name);
      symbols.push({ name, kind });
    }
  }

  // Extract brace-style exports: export { Foo, Bar as Baz }
  const exportBraceRe = new RegExp(EXPORT_BRACE_RE.source, "g");
  while ((m = exportBraceRe.exec(content)) !== null) {
    const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!.trim());
    for (const name of names) {
      if (name && !exports.includes(name)) {
        exports.push(name);
        symbols.push({ name, kind: "export" });
      }
    }
  }

  // Extract imports: import ... from 'module'
  const importRe = new RegExp(IMPORT_RE.source, "g");
  while ((m = importRe.exec(content)) !== null) {
    const src = m[1];
    if (src && !imports.includes(src)) {
      imports.push(src);
      symbols.push({ name: src, kind: "import", from: src });
    }
  }

  return { path: relPath, symbols, imports, exports };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a repo map by scanning TS/JS/Lua files for import/export statements.
 * Uses regex — no full AST parse needed.
 */
export async function buildRepoMap(repoDir: string): Promise<RepoMap> {
  const paths = await walkSourceFiles(repoDir, repoDir);
  const files: FileMap[] = [];

  for (const relPath of paths) {
    try {
      const fullPath = join(repoDir, relPath);
      const fileStat = await stat(fullPath);
      if (fileStat.size > 100 * 1024) continue; // skip very large files
      const content = await readFile(fullPath, "utf-8");
      files.push(parseFileMap(relPath, content));
    } catch {
      // unreadable — skip
    }
  }

  const summary = formatRepoMap({ files, summary: "" });
  return { files, summary };
}

/**
 * Format repo map as compact text for LLM consumption.
 * Format: "src/utils/math.ts → exports: lerp, round | imports: ./helpers"
 * Total output: ~50-100 tokens per file, not 200 lines of raw code.
 */
export function formatRepoMap(map: RepoMap): string {
  return map.files
    .map((f) => {
      const exportsStr = f.exports.length > 0 ? f.exports.join(", ") : "(none)";
      // Only show non-relative imports (package names) to keep it compact
      const externalImports = f.imports.filter((i) => !i.startsWith("."));
      const localImports = f.imports.filter((i) => i.startsWith("."));
      const importParts: string[] = [];
      if (externalImports.length > 0) importParts.push(externalImports.join(", "));
      if (localImports.length > 0) importParts.push(`local: ${localImports.length}`);
      const importsStr = importParts.length > 0 ? importParts.join(" | ") : "(none)";
      return `${f.path} → exports: ${exportsStr} | imports: ${importsStr}`;
    })
    .join("\n");
}
