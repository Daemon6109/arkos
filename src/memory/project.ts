// ─── Project Memory ───────────────────────────────────────────────────────────
// Persists per-project build metadata so workers know what already exists.
// Stored as `.arkos-project.json` in the project output directory.

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProjectFileRecord {
  path: string;
  purpose: string;
  exports: string[];
}

export interface ProjectSnapshot {
  goal: string;
  timestamp: number;
  files: ProjectFileRecord[];
  lessons: string[];
  runScore: number;
}

const SNAPSHOT_FILE = ".arkos-project.json";

// ─── ProjectMemory class ──────────────────────────────────────────────────────

export class ProjectMemory {
  private snapshotPath: string;

  constructor(private projectDir: string) {
    this.snapshotPath = join(projectDir, SNAPSHOT_FILE);
  }

  /** Load prior snapshot from the project directory. Returns null if none exists. */
  async load(): Promise<ProjectSnapshot | null> {
    if (!existsSync(this.snapshotPath)) return null;
    try {
      const raw = await readFile(this.snapshotPath, "utf-8");
      return JSON.parse(raw) as ProjectSnapshot;
    } catch {
      return null;
    }
  }

  /** Persist snapshot to the project directory. */
  async save(data: ProjectSnapshot): Promise<void> {
    try {
      await writeFile(this.snapshotPath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.warn(`⚠️  Could not save project memory: ${err}`);
    }
  }
}

// ─── Prompt helper ────────────────────────────────────────────────────────────

/**
 * Returns a human-readable summary of the prior build for injection into prompts.
 * Returns an empty string if no prior run exists.
 */
export async function getProjectContext(projectDir: string): Promise<string> {
  const memory = new ProjectMemory(projectDir);
  const snapshot = await memory.load();
  if (!snapshot) return "";

  const fileCount = snapshot.files.length;

  // Collect all unique exports across all files
  const allExports = [
    ...new Set(snapshot.files.flatMap((f) => f.exports).filter(Boolean)),
  ];

  const lines: string[] = [
    `Previously built: ${fileCount} file(s).`,
  ];

  if (allExports.length > 0) {
    lines.push(`Key exports: ${allExports.slice(0, 20).join(", ")}.`);
  }

  if (snapshot.lessons.length > 0) {
    lines.push(`Lessons: ${snapshot.lessons.slice(0, 5).join(" | ")}.`);
  }

  lines.push(`Prior run score: ${snapshot.runScore.toFixed(2)}.`);
  lines.push(`Goal was: "${snapshot.goal}".`);

  return lines.join(" ");
}
