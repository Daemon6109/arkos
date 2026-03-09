// ─── Arkos Kernel ─────────────────────────────────────────────────────────────
// Full pipeline orchestration:
// goal → vision (memory-informed) → simulate → extract goals → feasibility
//      → plan (goal-informed) → execute (parallel, file output)
//      → evaluate (adaptive retry) → memory

import { generateVision } from "../vision/index.js";
import { simulate } from "../simulator/index.js";
import { extractGoals } from "../goals/index.js";
import { checkFeasibility } from "../feasibility/index.js";
import { buildPlan, readyTasks } from "../planner/index.js";
import { executeGraph, assembleProject } from "../workers/index.js";
import { buildAndTest } from "../builder/index.js";
import { getStats, resetStats, printEfficiencyReport, saveEfficiencyReport } from "../optimizer/index.js";
import { evaluate, CONFIDENCE_THRESHOLD, MAX_RETRIES } from "../evaluator/index.js";
import { storeRun } from "../memory/index.js";
import { ProjectMemory, getProjectContext } from "../memory/project.js";
import { generate, stripThinking } from "../ollama.js";
import type { TaskResult, TaskGraph } from "../types.js";
import { join } from "path";
import { homedir } from "os";

export interface RunOptions {
  verbose?: boolean;
  outputDir?: string;
  skipSimulation?: boolean;
  language?: string;   // e.g. "TypeScript", "Python", "Lua"
}

export async function run(goal: string, opts: RunOptions = {}): Promise<void> {
  const { verbose = false, skipSimulation = false, language = "TypeScript" } = opts;

  // Output directory for generated files
  const outputDir = opts.outputDir ?? join(homedir(), ".arkos", "output", sanitizeName(goal));

  resetStats();
  console.log("\n🧠 Arkos — full pipeline");
  console.log(`Goal: ${goal}`);
  console.log(`Output: ${outputDir}\n`);

  // ── 1. Vision (memory-informed) ───────────────────────────────────────────
  console.log("[1/7] 👁️  Generating vision...");
  let vision = await generateVision(goal);
  console.log(`  → ${vision.name}: ${vision.description}`);
  if (verbose) console.log("  Components:", vision.components.join(", "));

  // ── Prior build context ───────────────────────────────────────────────────
  const projectMemory = new ProjectMemory(outputDir);
  const priorContext = await getProjectContext(outputDir);
  if (priorContext) {
    console.log(`  📂 Prior build found — injecting context into vision`);
    vision = {
      ...vision,
      rawVision: `PRIOR BUILD: ${priorContext}\n\n${vision.rawVision}`,
    };
  }

  // ── 2. Scenario Simulation ────────────────────────────────────────────────
  let goals: import("../goals/index.js").ExtractedGoal[] = [];

  if (!skipSimulation) {
    console.log("[2/7] 🎭  Simulating user personas...");
    const simulations = await simulate(vision);

    const avgFriction =
      simulations.reduce((sum, s) => sum + s.overallFriction, 0) / simulations.length;
    console.log(`  → Avg friction: ${avgFriction.toFixed(1)}/10`);

    for (const sim of simulations) {
      console.log(
        `  → [${sim.persona.name}] friction:${sim.overallFriction.toFixed(1)} confusion:${sim.overallConfusion.toFixed(1)} blockers:${sim.blockers.length}`
      );
      if (verbose && sim.blockers.length > 0) {
        sim.blockers.forEach((b) => console.log(`      blocker: ${b}`));
      }
    }

    // ── 3. Goal Extraction ──────────────────────────────────────────────────
    console.log("[3/7] 🎯  Extracting goals from simulation...");
    const goalResult = await extractGoals(simulations);
    goals = goalResult.goals;
    console.log(`  → ${goals.length} goals: ${goalResult.summary}`);
    if (verbose) goals.forEach((g) => console.log(`    [${g.impactScore.toFixed(2)}] ${g.description}`));

    // ── 4. Feasibility ──────────────────────────────────────────────────────
    console.log("[4/7] ✅  Checking feasibility...");
    const feasibility = await checkFeasibility(goals, vision);
    goals = feasibility.feasibleGoals;
    console.log(`  → ${goals.length} feasible, ${feasibility.infeasibleGoals.length} flagged`);
  } else {
    console.log("[2/7] 🎭  Simulation skipped");
    console.log("[3/7] 🎯  Goal extraction skipped");
    console.log("[4/7] ✅  Feasibility skipped");
  }

  // ── 5. Plan ───────────────────────────────────────────────────────────────
  console.log("[5/7] 📋  Building task graph + file map...");
  const graph = await buildPlan(vision, goals, language);
  console.log(`  → ${graph.tasks.length} tasks | ${graph.fileMap.length} files planned`);
  if (verbose) {
    graph.fileMap.forEach(f => console.log(`    ${f.path} — ${f.description}`));
  }
  if (verbose) {
    graph.tasks.forEach((t) => {
      const deps = t.dependsOn.length > 0 ? ` (after ${t.dependsOn.length} task(s))` : "";
      console.log(`    [${t.worker}] ${t.description}${deps}`);
    });
  }

  // ── 6. Execute + Adaptive Retry ───────────────────────────────────────────
  console.log("[6/7] ⚙️   Executing tasks...");
  const ctx = { outputDir, projectName: vision.name, language };
  let results = await executeGraph(graph, ctx);

  // Adaptive context retry loop
  results = await adaptiveRetry(results, graph, ctx, verbose);

  // ── Assembly pass — writes package.json, tsconfig, wires project ──────────
  await assembleProject(graph, ctx);

  // ── Build, lint, type-check, test (with auto-fix loop) ───────────────────
  console.log("[7/8] 🔨  Build + lint + test...");
  const buildResult = await buildAndTest(outputDir, language);
  console.log(`  → ${buildResult.summary}`);
  if (buildResult.errors.length > 0 && verbose) {
    buildResult.errors.forEach(e => console.log(`    ⚠️  ${e.slice(0, 120)}`));
  }

  // ── 8. Evaluate ───────────────────────────────────────────────────────────
  console.log("[8/8] 🔍  Evaluating output...");
  const evaluation = await evaluate(results, graph);

  const icon = evaluation.passed ? "✅" : "⚠️ ";
  console.log(`\n${icon} Pipeline complete`);
  console.log(`Score: ${evaluation.overallScore.toFixed(2)} | ${evaluation.summary}`);
  console.log(`Files written to: ${outputDir}`);

  if (verbose) {
    evaluation.taskEvaluations.forEach((te) => {
      console.log(`  [${te.action}] ${te.overall.toFixed(2)} — ${te.notes}`);
    });
  }

  // ── Memory ────────────────────────────────────────────────────────────────
  await storeRun(goal, vision, evaluation);

  // ── Project memory (per-directory) ────────────────────────────────────────
  const lessons = evaluation.taskEvaluations
    .filter((te) => te.notes)
    .map((te) => `[${te.action}] ${te.notes}`);
  await projectMemory.save({
    goal,
    timestamp: Date.now(),
    files: graph.fileMap.map((f) => ({
      path: f.path,
      purpose: f.description,
      exports: f.exports ?? [],
    })),
    lessons,
    runScore: evaluation.overallScore,
  });

  // ── Token efficiency report ───────────────────────────────────────────────
  const tokenStats = getStats();
  printEfficiencyReport(tokenStats);
  await saveEfficiencyReport(tokenStats, outputDir);

  // ── Push output to arkos-runs repo ────────────────────────────────────────
  await pushToRunsRepo(outputDir, goal, evaluation.overallScore);
}

// ─── Adaptive Retry ──────────────────────────────────────────────────────────
// When evaluator flags a task as retry_with_context, expand context and rerun.
// Bounded by MAX_RETRIES — never loops forever.

async function adaptiveRetry(
  results: TaskResult[],
  graph: TaskGraph,
  ctx: { outputDir: string; projectName: string },
  verbose: boolean
): Promise<TaskResult[]> {
  const { evaluate } = await import("../evaluator/index.js");
  const { executeGraph: exec } = await import("../workers/index.js");

  let attempt = 0;
  let currentResults = results;

  while (attempt < MAX_RETRIES) {
    const evaluation = await evaluate(currentResults, graph);
    const needsRetry = evaluation.taskEvaluations.filter(
      (te) => te.action === "retry_with_context"
    );

    if (needsRetry.length === 0) break;
    attempt++;

    console.log(`  🔄 Retry ${attempt}/${MAX_RETRIES}: ${needsRetry.length} task(s) need more context`);

    // Expand context for failing tasks using memory retrieval
    for (const te of needsRetry) {
      const task = graph.tasks.find((t) => t.id === te.taskId);
      if (!task) continue;

      // Build expanded context from other task outputs
      const relatedOutputs = currentResults
        .filter((r) => r.taskId !== te.taskId)
        .map((r) => `Previous task output (${r.worker}):\n${r.output.slice(0, 500)}`)
        .join("\n\n---\n\n");

      task.context.notes = `This is retry attempt ${attempt}. Previous attempt scored ${te.overall.toFixed(2)}. Additional context from other tasks:\n\n${relatedOutputs}`;
      task.status = "pending";

      if (verbose) console.log(`    Retrying: ${task.description}`);
    }

    // Re-execute only the tasks that need retry
    const retryGraph: TaskGraph = {
      goal: graph.goal,
      tasks: graph.tasks.filter((t) =>
        needsRetry.some((te) => te.taskId === t.id)
      ),
      fileMap: graph.fileMap,
      language: graph.language,
    };

    const retryResults = await exec(retryGraph, { ...ctx, language: graph.language });

    // Merge retry results into current results
    for (const retryResult of retryResults) {
      const idx = currentResults.findIndex((r) => r.taskId === retryResult.taskId);
      if (idx >= 0) {
        currentResults[idx] = retryResult;
      } else {
        currentResults.push(retryResult);
      }
    }
  }

  return currentResults;
}

async function pushToRunsRepo(outputDir: string, goal: string, score: number): Promise<void> {
  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const runsRepo = join(homedir(), ".arkos", "output");
    await execAsync(
      `git add -A && git commit -m "run: ${goal.slice(0, 60)} (score: ${score.toFixed(2)})" && git push`,
      { cwd: runsRepo }
    );
    console.log("  📤 pushed to arkos-runs");
  } catch {
    // Non-fatal — don't break the run if git fails
  }
}

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 50)
    .replace(/^-+|-+$/g, "");
}
