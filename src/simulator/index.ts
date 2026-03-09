// ─── Scenario Simulator ───────────────────────────────────────────────────────
// Imagines real user personas interacting with the product.
// Derives friction points, confusion zones, and delight moments.
// Goals are extracted from simulation results — not just from the raw prompt.

import { generate, stripThinking } from "../ollama.js";

function extractJsonObject(text: string): string {
  // Strip code fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  // Find outermost { }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1);
  return "{}";
}
import type { VisionObject, Persona, PersonaSimulation, SimulationStep } from "../types.js";

export const DEFAULT_PERSONAS: Persona[] = [
  {
    name: "novice",
    description: [
      "Retired teacher, 62 years old. Uses a smartphone but barely touches a computer.",
      "SPECIFIC BEHAVIORS: Clicks random buttons to 'see what happens'. Reads nothing before acting.",
      "Skips or dismisses every modal/tooltip without reading. Types slowly and makes typos.",
      "When stuck, waits 30 seconds staring at the screen before trying anything else.",
      "Will abandon the product if she hits the same wall twice. Cannot interpret error messages.",
      "Expects everything to work like Facebook. Confused by non-obvious icons.",
      "CONFUSION TRIGGERS: Any jargon (API, token, schema, config), multi-step flows without progress indicators, forms with no placeholder text.",
    ].join(" "),
    techLevel: "novice",
  },
  {
    name: "hobbyist",
    description: [
      "25-year-old hobbyist developer. Builds side projects but doesn't code professionally.",
      "SPECIFIC BEHAVIORS: Skims the README quickly, then jumps straight to trying things.",
      "Will copy-paste code without fully understanding it. Reads error messages but often misinterprets them.",
      "Opens the browser dev console when stuck. Tries 2-3 times before searching Google.",
      "Gets frustrated by undocumented config options. Will accept minor friction but not repeated failures.",
      "CONFUSION TRIGGERS: Inconsistent API naming, missing type hints, docs that assume knowledge he doesn't have, silent failures with no error output.",
    ].join(" "),
    techLevel: "hobbyist",
  },
  {
    name: "developer",
    description: [
      "Senior full-stack engineer, 8 years of experience. Has strong opinions.",
      "SPECIFIC BEHAVIORS: Goes straight to the source code or API reference — ignores marketing copy.",
      "Reads type signatures. Immediately notices missing exports, inconsistent naming, or leaky abstractions.",
      "Runs the linter/type checker before reading docs. Highly irritated by anything that should 'just work' but doesn't.",
      "Will file a bug report for poor DX but won't give up. Frustrated by hand-holding or over-abstraction.",
      "CONFUSION TRIGGERS: Anything that breaks the principle of least surprise, hidden side effects, global state, poor TypeScript types, missing overloads.",
    ].join(" "),
    techLevel: "developer",
  },
];

export async function simulate(
  vision: VisionObject,
  personas: Persona[] = DEFAULT_PERSONAS
): Promise<PersonaSimulation[]> {
  console.log(`  Simulating ${personas.length} personas...`);

  // Run all persona simulations in parallel
  const results = await Promise.all(
    personas.map((persona) => simulatePersona(vision, persona))
  );

  return results;
}

async function simulatePersona(
  vision: VisionObject,
  persona: Persona
): Promise<PersonaSimulation> {
  const prompt = `You are a UX researcher running a realistic usability simulation. You must predict EXACTLY what a specific user does at each step — not what an ideal user would do.

═══ PRODUCT ═══
Name: ${vision.name}
Description: ${vision.description}
Components: ${vision.components.join(", ")}
UX Flow: ${vision.uxFlow.join(" → ")}

═══ USER PERSONA ═══
Name: ${persona.name}
Profile: ${persona.description}

═══ SIMULATION RULES ═══
1. THINK STEP BY STEP before assigning any numbers.
2. For each step, first describe the EXACT action this specific user takes (not what they should do — what THEY actually do given their background and habits).
3. Describe what happens as a result (success, error, confusion, partial success).
4. THEN assign friction and confusion scores using these anchors:

FRICTION SCALE:
  0   = Completely smooth — user does it correctly on first try with zero hesitation
  1-2 = Minor bump — slight pause or small correction needed, user barely notices
  3-4 = Noticeable friction — user has to think, re-read, or try again once
  5-6 = Significant friction — user is visibly frustrated, multiple retries, nearly gives up
  7-8 = Major blocker — user is stuck for a long time, considers quitting
  9-10 = Wall — user gives up or cannot proceed at all

CONFUSION SCALE:
  0   = Crystal clear — user knows exactly what to do
  1-2 = Slight uncertainty — user guesses correctly
  3-4 = Moderate confusion — user tries wrong things first
  5-6 = High confusion — user doesn't understand what's being asked
  7-8 = Very lost — user has no idea what to do next
  9-10 = Complete bewilderment — user doesn't understand the product at all

5. Be REALISTIC: Different personas should get VERY different scores. A novice hitting a technical setup step should score 8-9 friction. A developer hitting the same step might score 1-2.
6. Include at least one step where this persona struggles significantly (friction ≥ 6).
7. Include at least one step where they succeed easily (friction ≤ 2).
8. Blockers = steps where this persona would likely quit for good.
9. Delights = moments that give the user confidence or satisfaction.

═══ OUTPUT FORMAT ═══
Respond ONLY with valid JSON (no markdown, no explanation):
{
  "steps": [
    {
      "action": "EXACT description of what THIS user does (be specific about mistakes, hesitations, misclicks)",
      "outcome": "What actually happens as a result — include errors, confusion states, or partial successes",
      "friction": <number 0-10 matching the scale above>,
      "confusion": <number 0-10 matching the scale above>
    }
  ],
  "blockers": ["specific scenario where this user would give up"],
  "delights": ["specific moment where this user feels successful or impressed"]
}`;

  const raw = await generate(prompt, { model: "qwen3:8b", temperature: 0.85, num_ctx: 6000 });
  const cleaned = stripThinking(raw);

  type RawSim = {
    steps: Array<{ action: string; outcome: string; friction: number; confusion: number }>;
    blockers: string[];
    delights: string[];
  };

  // For simulator: response is an object {}, not array — extract object first
  const jsonStr = extractJsonObject(cleaned);
  const parsed: RawSim = (() => {
    try { return JSON.parse(jsonStr); } catch { return { steps: [], blockers: [], delights: [] }; }
  })();

  const steps: SimulationStep[] = parsed.steps.map((s, i) => ({
    step: i + 1,
    action: s.action ?? "",
    outcome: s.outcome ?? "",
    friction: Math.min(10, Math.max(0, s.friction ?? 5)),
    confusion: Math.min(10, Math.max(0, s.confusion ?? 5)),
  }));

  const overallFriction =
    steps.length > 0
      ? steps.reduce((sum, s) => sum + s.friction, 0) / steps.length
      : 5;

  const overallConfusion =
    steps.length > 0
      ? steps.reduce((sum, s) => sum + s.confusion, 0) / steps.length
      : 5;

  // Time to success = number of steps (proxy)
  const successStep = steps.findIndex((s) => s.friction < 3);
  const timeToSuccess = successStep >= 0 ? successStep + 1 : steps.length;

  return {
    persona,
    steps,
    overallFriction,
    overallConfusion,
    timeToSuccess,
    blockers: parsed.blockers ?? [],
    delights: parsed.delights ?? [],
  };
}
