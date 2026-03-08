// ─── Ollama Client ────────────────────────────────────────────────────────────
// Shared wrapper around the Ollama API

export interface OllamaOptions {
  model?: string;
  temperature?: number;
  num_ctx?: number;
}

const DEFAULT_MODEL = "mistral:7b";
const OLLAMA_BASE = "http://127.0.0.1:11434";

export async function generate(prompt: string, opts: OllamaOptions = {}): Promise<string> {
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

  const data = (await res.json()) as { response: string };
  return data.response;
}

export function extractJson(text: string): string {
  // Strip ```json ... ``` fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  // Extract first {...} or [...] block
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) return objMatch[0];

  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) return arrMatch[0];

  return text;
}

export function parseJsonSafe<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(extractJson(text)) as T;
  } catch {
    return fallback;
  }
}
