// ─── Vision Generator ─────────────────────────────────────────────────────────
// Converts a raw goal into a structured design blueprint.
// Informed by memory — past lessons shape the vision before any execution begins.

import { generate, stripThinking, parseJsonSafe } from "../ollama.js";
import { getRelevantLessons } from "../memory/index.js";
import type { VisionObject } from "../types.js";

export async function generateVision(goal: string): Promise<VisionObject> {
  // Pull semantically relevant lessons from memory to inform the vision
  const lessons = await getRelevantLessons(goal, 8);
  const memorySection = lessons.length > 0
    ? `\nLessons from past runs (use these to avoid known mistakes):\n${lessons.map((l) => `- ${l}`).join("\n")}\n`
    : "";

  const prompt = `You are a product visionary. Given a goal, create a structured design blueprint BEFORE any implementation begins.
${memorySection}
Goal: ${goal}

Think about:
- What is the end product someone would actually experience?
- What are its core components / features?
- What is the UX flow a user goes through from start to finish?
- What technical constraints apply?
- What defines success for a real human using this?

Respond ONLY with JSON (no explanation, no markdown):
{
  "name": "short product name",
  "description": "1-2 sentence description of the product",
  "components": ["component1", "component2"],
  "uxFlow": ["step 1 user takes", "step 2", "step 3"],
  "techConstraints": ["constraint1", "constraint2"],
  "successMetrics": ["metric1", "metric2"]
}`;

  const raw = await generate(prompt, { model: "qwen3:14b", temperature: 0.7 });
  const cleaned = stripThinking(raw);

  // Vision response is an object — extract {} block directly
  const jsonStr = (() => {
    const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return fenced[1].trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) return cleaned.slice(start, end + 1);
    return "{}";
  })();

  const parsed: Partial<VisionObject> = (() => {
    try { return JSON.parse(jsonStr); } catch { return {}; }
  })();

  return {
    name: parsed.name ?? goal,
    description: parsed.description ?? "",
    components: parsed.components ?? [],
    uxFlow: parsed.uxFlow ?? [],
    techConstraints: parsed.techConstraints ?? [],
    successMetrics: parsed.successMetrics ?? [],
    rawVision: cleaned,
  };
}
