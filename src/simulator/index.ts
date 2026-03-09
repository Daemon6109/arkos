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
    description:
      "No tech background. Gets confused by jargon. Needs obvious affordances. Gives up easily if stuck. Uses products by feel, not by reading docs.",
    techLevel: "novice",
  },
  {
    name: "hobbyist",
    description:
      "Some software experience. Can follow instructions. Not a developer. Will try a few things before giving up. Reads tooltips but not full docs.",
    techLevel: "hobbyist",
  },
  {
    name: "developer",
    description:
      "Technical user. Wants power and control. Hates hand-holding. Will read source if needed. Frustrated by unnecessary friction or missing features.",
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
  const prompt = `You are simulating a real user interacting with a product for the first time.

Product: ${vision.name}
Description: ${vision.description}
Components: ${vision.components.join(", ")}
UX Flow: ${vision.uxFlow.join(" → ")}

You are playing this persona:
Name: ${persona.name}
Profile: ${persona.description}

Simulate this persona going through the product step by step. Be realistic — show confusion, mistakes, friction, and moments of delight. Don't make it too smooth.

For each step:
- action: what the user does
- outcome: what happens
- friction: 0-10 (0=smooth, 10=completely stuck)
- confusion: 0-10 (0=clear, 10=totally lost)

Also identify:
- blockers: things that would make this user quit
- delights: moments that make them want to continue

Respond ONLY with JSON:
{
  "steps": [
    {"action": "...", "outcome": "...", "friction": 3, "confusion": 2},
    ...
  ],
  "blockers": ["blocker1", "blocker2"],
  "delights": ["delight1", "delight2"]
}`;

  const raw = await generate(prompt, { model: "qwen3:8b", temperature: 0.8 });
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
