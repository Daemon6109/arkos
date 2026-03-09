// ─── Feasibility Checker ─────────────────────────────────────────────────────
// Validates that goals are technically and logically achievable.
// Flags infeasible goals for human review — never silently drops them.

import { generate, stripThinking, parseJsonSafe } from "../ollama.js";
import type { VisionObject } from "../types.js";
import type { ExtractedGoal } from "../goals/index.js";

export interface FeasibilityResult {
  goalId: string;
  feasible: boolean;
  effort: "low" | "medium" | "high";
  reason: string;
  dependencies: string[];
}

export interface FeasibilityReport {
  results: FeasibilityResult[];
  feasibleGoals: ExtractedGoal[];
  infeasibleGoals: ExtractedGoal[];
}

export async function checkFeasibility(
  goals: ExtractedGoal[],
  vision: VisionObject
): Promise<FeasibilityReport> {
  if (goals.length === 0) {
    return { results: [], feasibleGoals: [], infeasibleGoals: [] };
  }

  const goalList = goals.map((g, i) =>
    `${i + 1}. [${g.id}] ${g.description} (hint: ${g.feasibilityHint})`
  ).join("\n");

  const prompt = `You are a technical feasibility analyst. Evaluate whether these product goals are achievable given the product context.

Product: ${vision.name}
Tech constraints: ${vision.techConstraints.join(", ") || "none specified"}

Goals to evaluate:
${goalList}

For each goal, determine:
- feasible: true/false
- effort: "low", "medium", or "high"
- reason: brief explanation
- dependencies: other goals or tasks this depends on (by goal id, e.g. ["goal-1"])

Respond ONLY with JSON array:
[
  {
    "goalId": "goal-1",
    "feasible": true,
    "effort": "low",
    "reason": "Standard UI pattern, no novel engineering required",
    "dependencies": []
  }
]`;

  const raw = await generate(prompt, { model: "qwen3:8b", temperature: 0.3 }, "feasibility");
  const cleaned = stripThinking(raw);

  // Feasibility returns a JSON array
  const jsonStr = (() => {
    const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return fenced[1].trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start !== -1 && end > start) return cleaned.slice(start, end + 1);
    return "[]";
  })();

  const parsed: FeasibilityResult[] = (() => {
    try { return JSON.parse(jsonStr); } catch { return []; }
  })();

  // Build a map for quick lookup
  const resultMap = new Map<string, FeasibilityResult>(
    parsed.map((r) => [r.goalId, r])
  );

  // For any goals not in the response, default to feasible/medium
  const results: FeasibilityResult[] = goals.map((g) =>
    resultMap.get(g.id) ?? {
      goalId: g.id,
      feasible: true,
      effort: "medium" as const,
      reason: "Not explicitly evaluated — assuming feasible",
      dependencies: [],
    }
  );

  const feasibleGoals = goals.filter((g) => {
    const result = results.find((r) => r.goalId === g.id);
    return result?.feasible !== false;
  });

  const infeasibleGoals = goals.filter((g) => {
    const result = results.find((r) => r.goalId === g.id);
    return result?.feasible === false;
  });

  if (infeasibleGoals.length > 0) {
    console.log(`  ⚠️  ${infeasibleGoals.length} infeasible goal(s) flagged for review:`);
    for (const g of infeasibleGoals) {
      const r = results.find((r) => r.goalId === g.id);
      console.log(`    - [${g.id}] ${g.description}: ${r?.reason}`);
    }
  }

  return { results, feasibleGoals, infeasibleGoals };
}
