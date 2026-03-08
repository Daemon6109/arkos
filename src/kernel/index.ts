// ─── Arkos Kernel ─────────────────────────────────────────────────────────────
// Orchestrates the full pipeline:
// goal → vision → [simulate] → plan → execute → evaluate → memory

import { generateVision } from "../vision/index.js";
import { buildPlan } from "../planner/index.js";
import { executeGraph } from "../workers/index.js";
import { evaluate } from "../evaluator/index.js";
import { storeRun } from "../memory/index.js";

export interface RunOptions {
  verbose?: boolean;
}

export async function run(goal: string, opts: RunOptions = {}): Promise<void> {
  const { verbose = false } = opts;

  console.log("\n🧠 Arkos — starting pipeline");
  console.log(`Goal: ${goal}\n`);

  // ── Step 1: Vision ────────────────────────────────────────────────────────
  console.log("[1/6] 👁️  Generating vision...");
  const vision = await generateVision(goal);
  if (verbose) {
    console.log("  Vision:", JSON.stringify(vision, null, 2));
  } else {
    console.log(`  → ${vision.name}: ${vision.description}`);
    console.log(`  Components: ${vision.components.join(", ")}`);
  }

  // ── Step 2: Simulate (v2) ─────────────────────────────────────────────────
  console.log("[2/6] 🎭  Scenario simulation (v2 — skipped)");

  // ── Step 3: Feasibility (v2) ──────────────────────────────────────────────
  console.log("[3/6] ✅  Feasibility check (v2 — skipped)");

  // ── Step 4: Plan ──────────────────────────────────────────────────────────
  console.log("[4/6] 📋  Building task graph...");
  const graph = await buildPlan(vision);
  console.log(`  → ${graph.tasks.length} tasks planned`);
  if (verbose) {
    for (const t of graph.tasks) {
      console.log(`    [${t.worker}] ${t.description}`);
    }
  }

  // ── Step 5: Execute ───────────────────────────────────────────────────────
  console.log("[5/6] ⚙️   Executing tasks...");
  const results = await executeGraph(graph);

  // ── Step 6: Evaluate ──────────────────────────────────────────────────────
  console.log("[6/6] 🔍  Evaluating output...");
  const evaluation = await evaluate(results, graph);

  console.log(`\n${evaluation.passed ? "✅" : "⚠️ "} Pipeline complete`);
  console.log(`Score: ${evaluation.overallScore.toFixed(2)} | ${evaluation.summary}`);

  if (verbose) {
    for (const te of evaluation.taskEvaluations) {
      console.log(
        `  Task ${te.taskId.slice(0, 8)}: ${te.overall.toFixed(2)} [${te.action}]`
      );
    }
  }

  // ── Memory ────────────────────────────────────────────────────────────────
  await storeRun(goal, vision, evaluation);
}
