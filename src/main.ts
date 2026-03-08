#!/usr/bin/env tsx
// ─── Arkos CLI ────────────────────────────────────────────────────────────────

import { run } from "./kernel/index.js";
import { getStats } from "./memory/index.js";

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "help") {
  console.log(`
arkos — Cognitive AI orchestration engine

Usage:
  arkos run <goal>       Run a goal through the full pipeline
  arkos run <goal> -v    Verbose output
  arkos status           Show memory stats
  arkos help             Show this help
`);
  process.exit(0);
}

const command = args[0];

if (command === "run") {
  const verbose = args.includes("-v") || args.includes("--verbose");
  const goalArgs = args.filter((a) => a !== "run" && a !== "-v" && a !== "--verbose");
  const goal = goalArgs.join(" ").trim();

  if (!goal) {
    console.error("Error: please provide a goal");
    console.error('  arkos run "build a plugin manager for OpenClaw"');
    process.exit(1);
  }

  run(goal, { verbose }).catch((err) => {
    console.error("Arkos error:", err);
    process.exit(1);
  });
} else if (command === "status") {
  const stats = getStats();
  console.log("📊 Arkos Memory Stats");
  console.log(`  Total runs: ${stats.total}`);
  console.log(`  Passed: ${stats.passed}`);
  console.log(`  Avg score: ${stats.avgScore.toFixed(2)}`);
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
