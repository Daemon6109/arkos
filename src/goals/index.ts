// ─── Goal Extractor ───────────────────────────────────────────────────────────
// Converts simulation results into ranked, actionable goals.
// Goals are derived from user friction and confusion — not from abstract spec.

import { generate, stripThinking, parseJsonSafe } from "../ollama.js";
import type { PersonaSimulation } from "../types.js";

export interface ExtractedGoal {
  id: string;
  description: string;
  rationale: string;         // why this goal matters (which simulation triggered it)
  impactScore: number;       // 0-1, how many personas affected and how severely
  feasibilityHint: string;   // "easy" | "medium" | "hard"
  affectedPersonas: string[];
}

export interface GoalExtractionResult {
  goals: ExtractedGoal[];
  summary: string;
}

export async function extractGoals(
  simulations: PersonaSimulation[]
): Promise<GoalExtractionResult> {
  if (simulations.length === 0) {
    return { goals: [], summary: "No simulations to extract goals from." };
  }

  // Build a readable summary of simulation results for the LLM
  const simSummary = simulations.map((sim) => {
    const worstSteps = sim.steps
      .filter((s) => s.friction >= 6 || s.confusion >= 6)
      .map((s) => `  Step ${s.step}: [friction:${s.friction} confusion:${s.confusion}] ${s.action} → ${s.outcome}`)
      .join("\n");

    return `Persona: ${sim.persona.name} (${sim.persona.techLevel})
Overall friction: ${sim.overallFriction.toFixed(1)}/10
Overall confusion: ${sim.overallConfusion.toFixed(1)}/10
High-friction steps:
${worstSteps || "  (none)"}
Blockers: ${sim.blockers.join(", ") || "none"}
Delights: ${sim.delights.join(", ") || "none"}`;
  }).join("\n\n---\n\n");

  const prompt = `You are a product designer analyzing user simulation results. Extract concrete, actionable improvement goals from these simulation outcomes.

${simSummary}

Based on these simulation results, create a prioritized list of product improvement goals. Focus on:
- High-friction points (friction >= 6)
- Confusion blockers
- Goals that affect multiple personas (higher impact)
- Things that would prevent users from completing their task

For each goal:
- description: specific, actionable improvement (start with a verb)
- rationale: which simulation data triggered this goal
- impactScore: 0.0-1.0 based on how many personas affected and severity
- feasibilityHint: "easy", "medium", or "hard"
- affectedPersonas: list of persona names this goal helps

Respond ONLY with JSON:
{
  "goals": [
    {
      "description": "Add loading indicator after install button click",
      "rationale": "novice and hobbyist showed friction:8 confusion:9 waiting for feedback",
      "impactScore": 0.85,
      "feasibilityHint": "easy",
      "affectedPersonas": ["novice", "hobbyist"]
    }
  ],
  "summary": "2 critical blockers identified across all personas"
}`;

  const raw = await generate(prompt, { model: "qwen3:14b", temperature: 0.5 });
  const cleaned = stripThinking(raw);

  const jsonStr = (() => {
    const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return fenced[1].trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) return cleaned.slice(start, end + 1);
    return '{"goals":[],"summary":""}';
  })();

  const parsed: { goals: Omit<ExtractedGoal, "id">[]; summary: string } = (() => {
    try { return JSON.parse(jsonStr); } catch { return { goals: [], summary: "Goal extraction failed." }; }
  })();

  const goals: ExtractedGoal[] = (parsed.goals ?? []).map((g, i) => ({
    ...g,
    id: `goal-${i + 1}`,
    impactScore: Math.min(1, Math.max(0, g.impactScore ?? 0.5)),
  }));

  // Sort by impact score descending
  goals.sort((a, b) => b.impactScore - a.impactScore);

  return {
    goals,
    summary: parsed.summary ?? `${goals.length} goals extracted.`,
  };
}
