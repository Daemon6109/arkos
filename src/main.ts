#!/usr/bin/env tsx
// ─── Arkos CLI ────────────────────────────────────────────────────────────────

import { run } from "./kernel/index.js";
import { getStats } from "./memory/index.js";
import { startServer } from "./server/index.js";
import { runRefactor } from "./refactor/index.js";
import { runFinalizeAnalyze } from "./finalize/index.js";

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "help") {
  console.log(`
arkos — Cognitive AI orchestration engine

Usage:
  arkos run <goal>                          Run a goal through the full pipeline
  arkos run <goal> -v                       Verbose output
  arkos refactor "<goal>" --repos r1 r2     Cross-repo refactor analysis + PRs
  arkos refactor "<goal>" --repos r1 r2 --no-pr   Refactor without opening PRs
  arkos refactor "<goal>" --repos r1 r2 --lang TypeScript
  arkos finalize analyze                    Multi-repo gap analyzer
    --target <owner/repo>                   Repo to finalize
    --reference <owner/repo>                Reference repo to compare against
    --deps <owner/repo>...                  Dependency repos (space-separated)
  arkos serve                               Start HTTP API server (port 3847)
  arkos serve --port 8080                   Start on custom port
  arkos status                              Show memory stats
  arkos help                                Show this help
`);
  process.exit(0);
}

const command = args[0];

if (command === "run") {
  const verbose = args.includes("-v") || args.includes("--verbose");
  const skipSim = args.includes("--no-sim");

  // --lang TypeScript  or  --lang Python
  const langIdx = args.indexOf("--lang");
  const language = langIdx !== -1 ? args[langIdx + 1] : "TypeScript";

  const goalArgs = args.filter((a, i) => {
    if (["run", "-v", "--verbose", "--no-sim", "--lang"].includes(a)) return false;
    if (langIdx !== -1 && i === langIdx + 1) return false; // skip the lang value
    return true;
  });
  const goal = goalArgs.join(" ").trim();

  if (!goal) {
    console.error("Error: please provide a goal");
    console.error('  arkos run "build a plugin manager for OpenClaw"');
    console.error('  arkos run "build X" --lang Python --no-sim');
    process.exit(1);
  }

  run(goal, { verbose, skipSimulation: skipSim, language }).catch((err) => {
    console.error("Arkos error:", err);
    process.exit(1);
  });
} else if (command === "refactor") {
  const verbose = args.includes("-v") || args.includes("--verbose");
  const noPR = args.includes("--no-pr");

  // --lang TypeScript
  const langIdx = args.indexOf("--lang");
  const language = langIdx !== -1 ? args[langIdx + 1] : "TypeScript";

  // --repos owner/repo1 owner/repo2 ... (all args after --repos until next --flag or end)
  const reposIdx = args.indexOf("--repos");
  if (reposIdx === -1) {
    console.error("Error: --repos required");
    console.error('  arkos refactor "goal" --repos owner/repo1 owner/repo2');
    process.exit(1);
  }
  const repos: string[] = [];
  for (let i = reposIdx + 1; i < args.length; i++) {
    if (args[i].startsWith("--")) break;
    repos.push(args[i]);
  }
  if (repos.length < 2) {
    console.error("Error: --repos requires at least 2 repos");
    process.exit(1);
  }

  // Goal: everything before --repos / --lang / --no-pr / -v flags
  const flagsAndValues = new Set<string>();
  flagsAndValues.add("refactor");
  flagsAndValues.add("-v");
  flagsAndValues.add("--verbose");
  flagsAndValues.add("--no-pr");
  flagsAndValues.add("--repos");
  flagsAndValues.add("--lang");
  // Mark the flag values themselves
  if (langIdx !== -1) flagsAndValues.add(args[langIdx + 1]);
  repos.forEach((r) => flagsAndValues.add(r));

  const goalArgs = args.filter((a) => !flagsAndValues.has(a));
  const goal = goalArgs.join(" ").trim();

  if (!goal) {
    console.error("Error: please provide a refactor goal");
    console.error('  arkos refactor "consolidate shared utils" --repos owner/repo1 owner/repo2');
    process.exit(1);
  }

  runRefactor({ repos, goal, language, openPR: !noPR, verbose }).catch((err) => {
    console.error("Arkos refactor error:", err);
    process.exit(1);
  });
} else if (command === "finalize") {
  const subcommand = args[1];
  if (subcommand !== "analyze") {
    console.error(`Unknown finalize subcommand: ${subcommand ?? "(none)"}`);
    console.error("  arkos finalize analyze --target <owner/repo> [--reference <owner/repo>] [--deps <owner/repo>...]");
    process.exit(1);
  }

  const targetIdx = args.indexOf("--target");
  if (targetIdx === -1 || !args[targetIdx + 1]) {
    console.error("Error: --target is required");
    console.error("  arkos finalize analyze --target King-Studios-RBX/Anime-Reborn-Lobby");
    process.exit(1);
  }
  const target = args[targetIdx + 1]!;

  const refIdx = args.indexOf("--reference");
  const reference = refIdx !== -1 ? args[refIdx + 1] : undefined;

  // --deps: collect all values after --deps until next --flag
  const depsIdx = args.indexOf("--deps");
  const deps: string[] = [];
  if (depsIdx !== -1) {
    for (let i = depsIdx + 1; i < args.length; i++) {
      if (args[i]!.startsWith("--")) break;
      deps.push(args[i]!);
    }
  }

  const verbose = args.includes("-v") || args.includes("--verbose");

  runFinalizeAnalyze({ target, reference, deps, analyzeOnly: true, verbose }).catch((err) => {
    console.error("Arkos finalize error:", err);
    process.exit(1);
  });
} else if (command === "serve") {
  const portIdx = args.indexOf("--port");
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 3847;
  startServer(port);
  // Keep process alive
} else if (command === "status") {
  const stats = getStats();
  console.log("📊 Arkos Memory Stats");
  console.log(`  Total runs: ${stats.total}`);
  console.log(`  Passed: ${stats.passed}`);
  console.log(`  Avg score: ${stats.avgScore.toFixed(2)}`);
} else {
  console.error(`Unknown command: ${command}`);
  console.error("Commands: run, refactor, finalize, serve, status, help");
  process.exit(1);
}
