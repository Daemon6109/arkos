// ─── Ollama Client ────────────────────────────────────────────────────────────
// Shared wrapper around the Ollama API

export interface OllamaOptions {
  model?: string;
  temperature?: number;
  num_ctx?: number;
}

const DEFAULT_MODEL = "qwen3:14b";
// Windows host Ollama (6900XT) — accessible from WSL2 via host gateway IP
const OLLAMA_BASE = "http://172.30.176.1:11434";

export async function generate(
  prompt: string,
  opts: OllamaOptions = {},
  phase = "unknown"
): Promise<string> {
  const model = opts.model ?? DEFAULT_MODEL;

  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: {
        temperature: opts.temperature ?? 0.7,
        num_ctx: opts.num_ctx ?? 4096,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    response: string;
    prompt_eval_count?: number;
    eval_count?: number;
  };

  // Track tokens — Ollama returns exact counts
  const promptTokens = data.prompt_eval_count ?? Math.ceil(prompt.length / 4);
  const outputTokens = data.eval_count ?? Math.ceil((data.response?.length ?? 0) / 4);

  // Lazy import to avoid circular dependency
  try {
    const { recordTokens } = await import("./optimizer/index.js");
    recordTokens(phase, model, promptTokens, outputTokens);
  } catch {}

  return data.response;
}

export function stripThinking(text: string): string {
  // qwen3 wraps reasoning in <think>...</think> before the actual response
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export function extractJson(text: string): string {
  // Strip qwen3 thinking tokens first
  text = stripThinking(text);

  // Strip ```json ... ``` fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  // Extract first [...] block (arrays first — planner returns arrays)
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) return arrMatch[0];

  // Then objects
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) return objMatch[0];

  return text;
}

export function parseJsonSafe<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(extractJson(text)) as T;
  } catch {
    return fallback;
  }
}
