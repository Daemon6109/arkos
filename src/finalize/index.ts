// ─── Finalize Analyze ─────────────────────────────────────────────────────────
// Multi-repo gap analyzer: compares a target repo against a reference repo and
// dep packages to produce a structured TODO list of issues to fix.

import { readFile, mkdir } from "fs/promises";
import { join, basename, extname } from "path";
import { homedir } from "os";
import { cloneRepo } from "../tools/git.js";
import { buildRepoMap, type RepoMap } from "../tools/repo_map.js";
import { readRepoStructure, type RepoStructure } from "../tools/repo_reader.js";
import { generate, parseJsonSafe, stripThinking } from "../ollama.js";
import type { TodoItem, TodoType, FinalizeReport, FinalizeOptions } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function makeId(type: TodoType, label: string): string {
  return `${type.replace(/_/g, "-")}-${slugify(label)}`;
}

/** Extract package name from an ownerRepo string like "King-Studios-RBX/common" */
function pkgNameFromRepo(ownerRepo: string): string {
  const repoName = ownerRepo.split("/")[1] ?? ownerRepo;
  // Convention: @king-studios-rbx/<name>
  const owner = (ownerRepo.split("/")[0] ?? "").toLowerCase().replace(/_/g, "-");
  return `@${owner}/${repoName.toLowerCase().replace(/_/g, "-")}`;
}

/** Count non-blank lines */
function countLines(content: string): number {
  return content.split("\n").filter((l) => l.trim().length > 0).length;
}

// ─── Step 1: Clone ────────────────────────────────────────────────────────────

interface ClonedRepo {
  ownerRepo: string;
  localDir: string;
}

async function cloneAll(
  target: string,
  reference: string | undefined,
  deps: string[],
  timestamp: number
): Promise<{ target: ClonedRepo; reference?: ClonedRepo; deps: ClonedRepo[] }> {
  const base = `/tmp/arkos-finalize`;
  await mkdir(base, { recursive: true });

  const makeDir = (ownerRepo: string) => {
    const name = ownerRepo.split("/")[1] ?? ownerRepo.replace("/", "-");
    return join(base, `${name}-${timestamp}`);
  };

  console.log(`📥 Cloning target: ${target}...`);
  const targetDir = await cloneRepo(target, makeDir(target));

  let refClone: ClonedRepo | undefined;
  if (reference) {
    console.log(`📥 Cloning reference: ${reference}...`);
    const refDir = await cloneRepo(reference, makeDir(reference));
    refClone = { ownerRepo: reference, localDir: refDir };
  }

  const depClones: ClonedRepo[] = [];
  for (const dep of deps) {
    console.log(`📥 Cloning dep: ${dep}...`);
    const depDir = await cloneRepo(dep, makeDir(dep));
    depClones.push({ ownerRepo: dep, localDir: depDir });
  }

  return {
    target: { ownerRepo: target, localDir: targetDir },
    reference: refClone,
    deps: depClones,
  };
}

// ─── Step 2: Build Repo Maps ──────────────────────────────────────────────────

interface RepoData {
  ownerRepo: string;
  localDir: string;
  map: RepoMap;
  structure: RepoStructure;
}

async function buildAllRepoData(cloned: ClonedRepo): Promise<RepoData> {
  const [map, structure] = await Promise.all([
    buildRepoMap(cloned.localDir),
    readRepoStructure(cloned.localDir, cloned.ownerRepo),
  ]);
  return { ownerRepo: cloned.ownerRepo, localDir: cloned.localDir, map, structure };
}

// ─── Step 3: Import Cleanup + Type Cleanup ────────────────────────────────────

async function detectImportCleanup(
  targetData: RepoData,
  depDataList: RepoData[]
): Promise<TodoItem[]> {
  const todos: TodoItem[] = [];

  // Build map of dep basenames → dep info
  const depFileIndex = new Map<string, { depData: RepoData; relPath: string }>();
  for (const depData of depDataList) {
    for (const f of depData.map.files) {
      const b = basename(f.path, extname(f.path));
      depFileIndex.set(b.toLowerCase(), { depData, relPath: f.path });
    }
  }

  // Check target/src/shared/utils/ for duplicates in deps
  const utilFiles = targetData.map.files.filter((f) =>
    f.path.startsWith("src/shared/utils/") || f.path.startsWith("shared/utils/")
  );

  for (const uf of utilFiles) {
    const b = basename(uf.path, extname(uf.path)).toLowerCase();
    const match = depFileIndex.get(b);
    if (match) {
      const pkgName = pkgNameFromRepo(match.depData.ownerRepo);
      todos.push({
        id: makeId("import_cleanup", b),
        type: "import_cleanup",
        priority: "medium",
        title: `Remove local copy of ${b} utility`,
        description: `${uf.path} duplicates ${match.relPath} already provided by ${pkgName}. Remove the local copy and import from the package instead.`,
        targetFile: uf.path,
        referenceFile: match.relPath,
        suggestedChange: `Delete ${uf.path} and replace all imports with \`import { ... } from "${pkgName}"\``,
        estimatedComplexity: "simple",
      });
    }
  }

  // Check target/src/shared/types/ for type cleanup
  const typeFiles = targetData.map.files.filter((f) =>
    f.path.startsWith("src/shared/types/") || f.path.startsWith("shared/types/")
  );

  // Find the types dep (look for a dep whose name contains "types")
  const typesDep = depDataList.find(
    (d) => d.ownerRepo.toLowerCase().includes("types") || d.ownerRepo.toLowerCase().includes("type")
  );

  if (typesDep) {
    const typeDepIndex = new Map<string, string>();
    for (const f of typesDep.map.files) {
      const b = basename(f.path, extname(f.path));
      typeDepIndex.set(b.toLowerCase(), f.path);
    }

    for (const tf of typeFiles) {
      const b = basename(tf.path, extname(tf.path)).toLowerCase();
      const matchPath = typeDepIndex.get(b);
      if (matchPath) {
        const pkgName = pkgNameFromRepo(typesDep.ownerRepo);
        todos.push({
          id: makeId("type_cleanup", b),
          type: "type_cleanup",
          priority: "medium",
          title: `Remove local type definition: ${b}`,
          description: `${tf.path} likely duplicates types already defined in ${pkgName} (${matchPath}). Migrate to the shared types package.`,
          targetFile: tf.path,
          referenceFile: matchPath,
          suggestedChange: `Remove ${tf.path} and import types from "${pkgName}"`,
          estimatedComplexity: "simple",
        });
      }
    }
  }

  return todos;
}

// ─── Step 4: Service/Controller Gap Detection ─────────────────────────────────

/** Extract service/controller names from a repo's file list */
function extractServiceNames(data: RepoData): Map<string, string> {
  const names = new Map<string, string>(); // normalized-name → relPath
  for (const f of data.map.files) {
    const lower = f.path.toLowerCase();
    if (
      lower.includes("service") ||
      lower.includes("controller") ||
      lower.includes("manager")
    ) {
      const b = basename(f.path, extname(f.path)).toLowerCase();
      names.set(b, f.path);
    }
  }
  return names;
}

async function detectServiceGaps(
  targetData: RepoData,
  referenceData: RepoData
): Promise<TodoItem[]> {
  const todos: TodoItem[] = [];

  const refServices = extractServiceNames(referenceData);
  const targetServices = extractServiceNames(targetData);

  // service_missing: in reference but not target
  for (const [name, refPath] of refServices) {
    if (!targetServices.has(name)) {
      todos.push({
        id: makeId("service_missing", name),
        type: "service_missing",
        priority: "high",
        title: `Missing service/controller: ${name}`,
        description: `${refPath} exists in the reference repo but has no counterpart in the target. This service needs to be created or ported.`,
        referenceFile: refPath,
        suggestedChange: `Port or create a counterpart to ${refPath} in the target repo`,
        estimatedComplexity: "moderate",
      });
    }
  }

  // service_incomplete: exists in target but looks like a stub
  for (const [name, targetPath] of targetServices) {
    const fileEntry = targetData.structure.files.find((f) => f.path === targetPath);
    if (!fileEntry) continue;

    const content = fileEntry.content;
    const lines = countLines(content);
    const hasTodo = /TODO|FIXME|stub|placeholder/i.test(content);
    // Check for Flamework DI decorators
    const hasDI = /@Service|@Controller|@Component|@Dependency/i.test(content);

    if (lines < 50 || hasTodo || !hasDI) {
      const reasons: string[] = [];
      if (lines < 50) reasons.push(`only ${lines} non-blank lines`);
      if (hasTodo) reasons.push("contains TODO/FIXME comments");
      if (!hasDI) reasons.push("missing Flamework DI decorators");

      todos.push({
        id: makeId("service_incomplete", name),
        type: "service_incomplete",
        priority: "high",
        title: `Incomplete service/controller: ${name}`,
        description: `${targetPath} appears to be a stub or incomplete (${reasons.join(", ")}).`,
        targetFile: targetPath,
        referenceFile: refServices.get(name),
        suggestedChange: `Implement full service logic; add @Service/@Controller decorator and dependency injection`,
        estimatedComplexity: "moderate",
      });
    }
  }

  return todos;
}

// ─── Step 5: Networking Issues ────────────────────────────────────────────────

async function detectNetworkingIssues(targetData: RepoData): Promise<TodoItem[]> {
  const todos: TodoItem[] = [];

  const badNetworkingPkgs = ["@rbxts/net", "tether", "blink"];

  for (const f of targetData.map.files) {
    const badImports = f.imports.filter((imp) =>
      badNetworkingPkgs.some((pkg) => imp === pkg || imp.startsWith(`${pkg}/`))
    );

    for (const badImp of badImports) {
      todos.push({
        id: makeId("networking_issue", `${basename(f.path, extname(f.path))}-${badImp}`),
        type: "networking_issue",
        priority: "critical",
        title: `Wrong networking package in ${basename(f.path)}`,
        description: `${f.path} imports from "${badImp}" which is not the correct networking solution. Roblox-TS Flamework projects should use @flamework/networking with GlobalEvents/GlobalFunctions.`,
        targetFile: f.path,
        suggestedChange: `Replace "${badImp}" with "@flamework/networking" and refactor to use GlobalEvents/GlobalFunctions pattern`,
        estimatedComplexity: "moderate",
      });
    }
  }

  // Check src/shared/network.ts for correct pattern
  const networkFile = targetData.structure.files.find(
    (f) => f.path === "src/shared/network.ts" || f.path === "shared/network.ts"
  );

  if (networkFile) {
    const content = networkFile.content;
    const usesGlobalEvents = /GlobalEvents|GlobalFunctions/i.test(content);
    const usesFlameworkNetworking = /@flamework\/networking/i.test(content);

    if (!usesGlobalEvents || !usesFlameworkNetworking) {
      todos.push({
        id: "networking-issue-shared-network-ts",
        type: "networking_issue",
        priority: "critical",
        title: "network.ts doesn't use @flamework/networking pattern",
        description: `${networkFile.path} does not use the GlobalEvents/GlobalFunctions pattern from @flamework/networking. This is the required networking pattern for Flamework projects.`,
        targetFile: networkFile.path,
        suggestedChange:
          "Refactor network.ts to export GlobalEvents and GlobalFunctions using @flamework/networking. See reference repo for correct pattern.",
        estimatedComplexity: "simple",
      });
    }
  } else {
    // network.ts is missing entirely
    todos.push({
      id: "networking-issue-missing-network-ts",
      type: "networking_issue",
      priority: "critical",
      title: "Missing src/shared/network.ts",
      description:
        "No network.ts found in src/shared/. This file is required to define GlobalEvents and GlobalFunctions for @flamework/networking.",
      suggestedChange:
        "Create src/shared/network.ts with GlobalEvents and GlobalFunctions exports using @flamework/networking",
      estimatedComplexity: "simple",
    });
  }

  return todos;
}

// ─── Step 6: Unused Dependencies ─────────────────────────────────────────────

async function detectUnusedDeps(targetData: RepoData): Promise<TodoItem[]> {
  const todos: TodoItem[] = [];

  const pkgJson = targetData.structure.packageJson;
  if (!pkgJson) return todos;

  const deps: Record<string, string> = {
    ...((pkgJson.dependencies as Record<string, string>) ?? {}),
    ...((pkgJson.devDependencies as Record<string, string>) ?? {}),
    ...((pkgJson.peerDependencies as Record<string, string>) ?? {}),
  };

  // Collect all imports across src/ files
  const allImports = new Set<string>();
  for (const f of targetData.map.files) {
    if (!f.path.startsWith("src/")) continue;
    for (const imp of f.imports) {
      // normalize: strip sub-paths, e.g. "@scope/pkg/sub" → "@scope/pkg"
      const parts = imp.split("/");
      const pkgName = imp.startsWith("@")
        ? `${parts[0]}/${parts[1]}`
        : parts[0];
      if (pkgName) allImports.add(pkgName);
    }
  }

  // Skip common non-imported deps (build tools, type-only packages, etc.)
  const skipPkgs = new Set([
    "typescript",
    "rbxtsc",
    "@rbxts/compiler-types",
    "@rbxts/types",
    "bun",
    "prettier",
    "eslint",
    "@types/node",
    "roblox-ts",
  ]);

  for (const pkgName of Object.keys(deps)) {
    if (skipPkgs.has(pkgName)) continue;
    if (!allImports.has(pkgName)) {
      todos.push({
        id: makeId("dependency_unused", pkgName),
        type: "dependency_unused",
        priority: "low",
        title: `Unused dependency: ${pkgName}`,
        description: `"${pkgName}" is listed in package.json but no file in src/ imports from it. Either remove it or start using it.`,
        suggestedChange: `Run \`npm uninstall ${pkgName}\` if it is not needed`,
        estimatedComplexity: "trivial",
      });
    }
  }

  return todos;
}

// ─── Step 7: LLM Enrichment ───────────────────────────────────────────────────

async function enrichWithLLM(items: TodoItem[], targetRepo: string): Promise<TodoItem[]> {
  if (items.length === 0) return items;

  const prompt = `You are a senior Roblox TypeScript architect reviewing these issues found in a lobby repo (${targetRepo}).

The issues were mechanically detected. Your job is to:
1. Assign or adjust priority (critical/high/medium/low) — focus on items affecting compilability and Flamework best practices first
2. Write a brief, actionable suggestedChange (1-2 sentences max)
3. Verify or adjust estimatedComplexity (trivial/simple/moderate/complex)

Issues to review:
${JSON.stringify(items, null, 2)}

Respond with a JSON array of the same items, with updated priority, suggestedChange, and estimatedComplexity fields.
Only return the JSON array, no commentary.`;

  try {
    const raw = await generate(prompt, { model: "qwen3:14b", num_predict: 4096 }, "finalize-enrich");
    const enriched = parseJsonSafe<TodoItem[]>(raw, items);

    // Validate: must be an array of same length
    if (!Array.isArray(enriched) || enriched.length !== items.length) {
      console.warn("⚠️  LLM enrichment returned unexpected shape, using mechanical results");
      return items;
    }

    // Merge: keep mechanical IDs/types/titles/descriptions, take enriched priority/suggestedChange/complexity
    return items.map((item, i) => {
      const enrichedItem = enriched[i];
      if (!enrichedItem) return item;
      return {
        ...item,
        priority: enrichedItem.priority ?? item.priority,
        suggestedChange: enrichedItem.suggestedChange ?? item.suggestedChange,
        estimatedComplexity: enrichedItem.estimatedComplexity ?? item.estimatedComplexity,
      };
    });
  } catch (err) {
    console.warn(`⚠️  LLM enrichment failed (${err instanceof Error ? err.message : String(err)}), using mechanical results`);
    return items;
  }
}

// ─── Step 8: Output ───────────────────────────────────────────────────────────

function printSummary(report: FinalizeReport): void {
  console.log("\n" + "═".repeat(60));
  console.log(`📋 Finalize Analysis: ${report.targetRepo}`);
  console.log(`📅 ${report.analyzedAt}`);
  console.log(`🔢 Total issues: ${report.totalItems}`);
  console.log("═".repeat(60));

  // Group by type
  const byType = new Map<TodoType, TodoItem[]>();
  for (const item of report.items) {
    const list = byType.get(item.type) ?? [];
    list.push(item);
    byType.set(item.type, list);
  }

  const typeLabels: Record<TodoType, string> = {
    import_cleanup: "🔗 Import Cleanup",
    service_incomplete: "🔧 Incomplete Services",
    service_missing: "❌ Missing Services",
    networking_issue: "🌐 Networking Issues",
    type_cleanup: "📦 Type Cleanup",
    dependency_unused: "🗑️  Unused Dependencies",
    flamework_pattern: "⚙️  Flamework Patterns",
  };

  const priorityOrder: TodoItem["priority"][] = ["critical", "high", "medium", "low"];
  const priorityEmoji: Record<TodoItem["priority"], string> = {
    critical: "🔴",
    high: "🟠",
    medium: "🟡",
    low: "🟢",
  };

  for (const type of Object.keys(typeLabels) as TodoType[]) {
    const items = byType.get(type);
    if (!items || items.length === 0) continue;

    console.log(`\n${typeLabels[type]} (${items.length})`);
    const sorted = [...items].sort(
      (a, b) => priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority)
    );

    for (const item of sorted) {
      console.log(`  ${priorityEmoji[item.priority]} [${item.priority.toUpperCase()}] ${item.title}`);
      if (item.targetFile) console.log(`     📄 ${item.targetFile}`);
      if (item.suggestedChange) console.log(`     💡 ${item.suggestedChange}`);
    }
  }

  console.log("\n" + "═".repeat(60));

  // Priority breakdown
  const priorityCount = new Map<TodoItem["priority"], number>();
  for (const item of report.items) {
    priorityCount.set(item.priority, (priorityCount.get(item.priority) ?? 0) + 1);
  }
  for (const p of priorityOrder) {
    const count = priorityCount.get(p);
    if (count) console.log(`  ${priorityEmoji[p]} ${p}: ${count}`);
  }
  console.log("═".repeat(60) + "\n");
}

async function writeReport(report: FinalizeReport): Promise<string> {
  const arkosDir = join(homedir(), ".arkos");
  await mkdir(arkosDir, { recursive: true });
  const outPath = join(arkosDir, "finalize-todo.json");
  const { writeFile } = await import("fs/promises");
  await writeFile(outPath, JSON.stringify(report, null, 2), "utf-8");
  return outPath;
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function runFinalizeAnalyze(opts: FinalizeOptions): Promise<void> {
  console.log("🔍 Arkos Finalize Analyze");
  console.log(`   Target:    ${opts.target}`);
  if (opts.reference) console.log(`   Reference: ${opts.reference}`);
  if (opts.deps.length > 0) console.log(`   Deps:      ${opts.deps.join(", ")}`);
  console.log("");

  const timestamp = Date.now();

  // Step 1: Clone all repos
  const cloned = await cloneAll(opts.target, opts.reference, opts.deps, timestamp);

  // Step 2: Build repo maps
  console.log("🗺️  Building repo maps...");
  const targetData = await buildAllRepoData(cloned.target);
  const referenceData = cloned.reference ? await buildAllRepoData(cloned.reference) : undefined;
  const depDataList = await Promise.all(cloned.deps.map(buildAllRepoData));

  // Step 3: Detect import/type cleanup
  console.log("🔎 Detecting import/type cleanup issues...");
  const importCleanupTodos = await detectImportCleanup(targetData, depDataList);

  // Step 4: Service/controller gap detection
  let serviceGapTodos: TodoItem[] = [];
  if (referenceData) {
    console.log("🔎 Detecting service/controller gaps...");
    serviceGapTodos = await detectServiceGaps(targetData, referenceData);
  }

  // Step 5: Networking issues
  console.log("🔎 Detecting networking issues...");
  const networkingTodos = await detectNetworkingIssues(targetData);

  // Step 6: Unused dependencies
  console.log("🔎 Detecting unused dependencies...");
  const unusedDepTodos = await detectUnusedDeps(targetData);

  // Combine all mechanical todos
  const allTodos: TodoItem[] = [
    ...importCleanupTodos,
    ...serviceGapTodos,
    ...networkingTodos,
    ...unusedDepTodos,
  ];

  console.log(`\n✅ Mechanical detection found ${allTodos.length} issues`);

  // Step 7: LLM enrichment
  let enrichedTodos = allTodos;
  if (allTodos.length > 0) {
    console.log("🤖 Running LLM enrichment pass (qwen3:14b)...");
    enrichedTodos = await enrichWithLLM(allTodos, opts.target);
    console.log("✅ LLM enrichment complete");
  }

  // Step 8: Output
  const report: FinalizeReport = {
    targetRepo: opts.target,
    analyzedAt: new Date().toISOString(),
    totalItems: enrichedTodos.length,
    items: enrichedTodos,
  };

  const outPath = await writeReport(report);
  console.log(`\n💾 Report written to: ${outPath}`);

  printSummary(report);
}
