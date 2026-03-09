// ─── Planner ──────────────────────────────────────────────────────────────────
// Two-phase planning:
// 1. File Map — decide the full project structure upfront (what files exist, what they export)
// 2. Task Graph — bind each task to a specific file, with real dependencies

import { generate, stripThinking, parseJsonSafe } from "../ollama.js";
import type { VisionObject, Task, TaskGraph, TaskStatus, WorkerType, FileMapEntry } from "../types.js";
import type { ExtractedGoal } from "../goals/index.js";
import { randomUUID } from "crypto";

export function readyTasks(graph: TaskGraph): Task[] {
  const completedIds = new Set(
    graph.tasks.filter((t) => t.status === "complete").map((t) => t.id)
  );
  return graph.tasks.filter(
    (t) =>
      t.status === "pending" &&
      t.dependsOn.every((dep) => completedIds.has(dep))
  );
}

export async function buildPlan(
  vision: VisionObject,
  goals: ExtractedGoal[] = [],
  language: string = "TypeScript"
): Promise<TaskGraph> {

  // ── Phase 1: Generate file map ─────────────────────────────────────────────
  const fileMap = await generateFileMap(vision, language);

  // ── Phase 2: Generate task graph bound to file map ─────────────────────────
  const graph = await generateTaskGraph(vision, goals, fileMap, language);

  return graph;
}

async function generateFileMap(
  vision: VisionObject,
  language: string
): Promise<FileMapEntry[]> {
  const ext = langToExt(language);

  const prompt = `You are a software architect. Design the complete file structure for this project BEFORE any code is written.

Project: ${vision.name}
Description: ${vision.description}
Components: ${vision.components.join(", ")}
Language: ${language}

Design the file structure. Every file should have a single clear responsibility.
Include: source files, test files, config files (package.json, tsconfig.json if TS).

Rules:
- Source files go in src/
- Test files go in tests/
- Keep it minimal — 4-8 files max
- Each file should export specific named symbols
- Include package.json and any needed config

Respond ONLY with JSON array:
[
  {
    "path": "src/scanner.${ext}",
    "description": "File system directory scanner with error handling",
    "exports": ["scanDirectory", "FileEntry"]
  },
  {
    "path": "src/formatter.${ext}",
    "description": "Human-readable formatters for file size and dates",
    "exports": ["formatSize", "formatDate"]
  },
  {
    "path": "src/cli.${ext}",
    "description": "CLI entry point with argument parsing",
    "exports": ["run"]
  },
  {
    "path": "tests/scanner.spec.${ext}",
    "description": "Unit tests for the scanner module",
    "exports": []
  },
  {
    "path": "package.json",
    "description": "Project config with dependencies and scripts",
    "exports": []
  }
]`;

  const raw = await generate(prompt, { model: "qwen3:14b", temperature: 0.3 });
  const cleaned = stripThinking(raw);

  const jsonStr = (() => {
    const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return fenced[1].trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start !== -1 && end > start) return cleaned.slice(start, end + 1);
    return "[]";
  })();

  const parsed: FileMapEntry[] = (() => {
    try { return JSON.parse(jsonStr); } catch { return []; }
  })();

  return parsed.length > 0 ? parsed : defaultFileMap(vision.name, ext);
}

async function generateTaskGraph(
  vision: VisionObject,
  goals: ExtractedGoal[],
  fileMap: FileMapEntry[],
  language: string
): Promise<TaskGraph> {

  const fileList = fileMap
    .map((f, i) => `${i}. ${f.path} — ${f.description} [exports: ${f.exports.join(", ") || "none"}]`)
    .join("\n");

  const goalsSection = goals.length > 0
    ? `\nUser-centered goals:\n${goals.slice(0, 5).map(g => `- ${g.description}`).join("\n")}\n`
    : "";

  const prompt = `You are a software project planner. Create a task list where EACH TASK writes to EXACTLY ONE FILE from the file map.

Project: ${vision.name}
Language: ${language}
${goalsSection}
File map (each task must target one of these):
${fileList}

Rules:
- One task per file (or one task per major config file)
- Use fileIndex to reference which file from the list above (0-based)
- Worker types: code_gen, test_runner, doc_writer, file_ops
- Set real dependencies — tests depend on their source file being done

Respond ONLY with JSON array:
[
  {
    "description": "implement directory scanner with fs.readdirSync and error handling",
    "worker": "code_gen",
    "fileIndex": 0,
    "dependsOn": []
  },
  {
    "description": "write unit tests for scanDirectory covering edge cases",
    "worker": "test_runner",
    "fileIndex": 3,
    "dependsOn": [0]
  }
]`;

  const raw = await generate(prompt, { model: "qwen3:14b", temperature: 0.3 });
  const cleaned = stripThinking(raw);

  const jsonStr = (() => {
    const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return fenced[1].trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start !== -1 && end > start) return cleaned.slice(start, end + 1);
    return "[]";
  })();

  type RawTask = { description: string; worker: string; fileIndex: number; dependsOn: number[] };
  const rawTasks: RawTask[] = (() => {
    try { return JSON.parse(jsonStr); } catch { return []; }
  })();

  const tasks: Task[] = [];
  const taskIds: string[] = [];

  for (const raw of rawTasks) {
    const id = randomUUID();
    const fileEntry = fileMap[raw.fileIndex ?? 0];
    const worker = validateWorker(raw.worker);
    const dependsOn = (raw.dependsOn ?? [])
      .map((i: number) => taskIds[i])
      .filter(Boolean) as string[];

    tasks.push({
      id,
      description: raw.description ?? "unnamed task",
      worker,
      dependsOn,
      context: { files: [], notes: "" },
      status: "pending" as TaskStatus,
      targetFile: fileEntry?.path,
      exports: fileEntry?.exports ?? [],
    });
    taskIds.push(id);
  }

  if (tasks.length === 0) {
    // Fallback
    const id = randomUUID();
    tasks.push({
      id,
      description: `Implement ${vision.name}`,
      worker: "code_gen",
      dependsOn: [],
      context: { files: [], notes: "" },
      status: "pending",
      targetFile: fileMap[0]?.path ?? `src/index.${langToExt(language)}`,
      exports: [],
    });
  }

  return { goal: vision.name, tasks, fileMap, language };
}

function defaultFileMap(projectName: string, ext: string): FileMapEntry[] {
  const name = projectName.toLowerCase().replace(/\s+/g, "-");
  return [
    { path: `src/${name}.${ext}`, description: "Main implementation", exports: ["main"] },
    { path: `tests/${name}.spec.${ext}`, description: "Unit tests", exports: [] },
    { path: "package.json", description: "Project config", exports: [] },
  ];
}

function validateWorker(worker: string): WorkerType {
  const valid: WorkerType[] = ["code_gen", "debugger", "doc_writer", "test_runner", "file_ops"];
  return valid.includes(worker as WorkerType) ? (worker as WorkerType) : "code_gen";
}

function langToExt(lang: string): string {
  const map: Record<string, string> = {
    TypeScript: "ts", JavaScript: "js", Python: "py",
    Rust: "rs", Go: "go", Lua: "lua",
  };
  return map[lang] ?? "ts";
}
