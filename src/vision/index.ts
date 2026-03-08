// ─── Vision Generator ─────────────────────────────────────────────────────────
// Converts a raw goal into a structured design blueprint.
// The AI forms a mental model of the end product BEFORE any execution begins.

import { generate, parseJsonSafe } from "../ollama.js";
import type { VisionObject } from "../types.js";

export async function generateVision(goal: string): Promise<VisionObject> {
  const prompt = `You are a product visionary. Given a goal, create a structured design blueprint BEFORE any implementation.

Goal: ${goal}

Think about:
- What is the end product someone would actually experience?
- What are its core components / features?
- What is the UX flow a user goes through?
- What technical constraints apply?
- What defines success for a real human using this?

Respond ONLY with JSON (no explanation):
{
  "name": "short product name",
  "description": "1-2 sentence description of the product",
  "components": ["component1", "component2"],
  "uxFlow": ["step 1 user takes", "step 2", "step 3"],
  "techConstraints": ["constraint1", "constraint2"],
  "successMetrics": ["metric1", "metric2"]
}`;

  const raw = await generate(prompt, { model: "mistral:7b", temperature: 0.7 });

  const parsed = parseJsonSafe<Partial<VisionObject>>(raw, {});

  return {
    name: parsed.name ?? goal,
    description: parsed.description ?? "",
    components: parsed.components ?? [],
    uxFlow: parsed.uxFlow ?? [],
    techConstraints: parsed.techConstraints ?? [],
    successMetrics: parsed.successMetrics ?? [],
    rawVision: raw,
  };
}
