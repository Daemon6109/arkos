// ─── Embedding-based File Retrieval ──────────────────────────────────────────
// Uses nomic-embed-text to semantically rank files by relevance to a goal.

const OLLAMA_BASE = "http://172.30.176.1:11434";
const EMBED_MODEL = "nomic-embed-text";

// In-memory embedding cache keyed by content hash
const embeddingCache = new Map<string, number[]>();

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

async function embedText(text: string): Promise<number[]> {
  const key = simpleHash(text);
  const cached = embeddingCache.get(key);
  if (cached) return cached;

  const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });

  if (!res.ok) {
    throw new Error(
      `Embedding error: ${res.status} ${await res.text()}`
    );
  }

  const data = (await res.json()) as { embeddings: number[][] };
  const embedding = data.embeddings[0];
  embeddingCache.set(key, embedding);
  return embedding;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function findRelevantFiles(
  goal: string,
  files: Array<{ path: string; content: string }>,
  topN = 15
): Promise<Array<{ path: string; content: string; score: number }>> {
  const goalEmbedding = await embedText(goal);

  // Embed all files in parallel
  const scored = await Promise.all(
    files.map(async (file) => {
      const snippet = `${file.path}\n${file.content.slice(0, 500)}`;
      const embedding = await embedText(snippet);
      const score = cosineSimilarity(goalEmbedding, embedding);
      return { ...file, score };
    })
  );

  // Sort descending by score, return top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}
