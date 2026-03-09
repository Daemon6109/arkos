// ─── Context7 MCP Docs Fetcher ────────────────────────────────────────────────
// Fetches live package documentation from Context7's REST API before code gen.
// Results are cached in-memory so the same package is never fetched twice per run.

const CONTEXT7_BASE = "https://mcp.context7.com/v1";
const TIMEOUT_MS = 10_000;
const CACHE_TOKENS = 4000;

/** In-memory cache: "packageName:topic" → formatted docs string */
const docsCache = new Map<string, string>();

/**
 * Fetch live documentation for a package from Context7.
 * Returns a formatted string `"[Context7 docs for <package>]\n<content>"`.
 * Returns empty string on any failure — never throws.
 */
export async function getLibraryDocs(
  packageName: string,
  topic?: string
): Promise<string> {
  const cacheKey = `${packageName}:${topic ?? ""}`;
  if (docsCache.has(cacheKey)) {
    return docsCache.get(cacheKey)!;
  }

  try {
    // Step 1: search for the library to get its ID
    const libraryId = await searchLibrary(packageName);
    if (!libraryId) {
      docsCache.set(cacheKey, "");
      return "";
    }

    // Step 2: fetch the docs
    const content = await fetchDocs(libraryId, topic);
    if (!content) {
      docsCache.set(cacheKey, "");
      return "";
    }

    const formatted = `[Context7 docs for ${packageName}]\n${content}`;
    docsCache.set(cacheKey, formatted);
    return formatted;
  } catch {
    docsCache.set(cacheKey, "");
    return "";
  }
}

async function searchLibrary(packageName: string): Promise<string | null> {
  const url = `${CONTEXT7_BASE}/search?query=${encodeURIComponent(packageName)}`;
  const res = await fetchWithTimeout(url, TIMEOUT_MS);
  if (!res.ok) return null;

  const data = await res.json() as unknown;

  // Response shape: { results: Array<{ id: string, name: string, ... }> }
  // or sometimes { libraries: [...] }
  const results = extractArray(data, ["results", "libraries", "hits", "data"]);
  if (!results || results.length === 0) return null;

  // Prefer exact match on name, otherwise take first result
  const exact = results.find(
    (r: Record<string, unknown>) =>
      typeof r.id === "string" &&
      (String(r.name ?? "").toLowerCase() === packageName.toLowerCase() ||
       String(r.package ?? "").toLowerCase() === packageName.toLowerCase())
  ) as Record<string, unknown> | undefined;

  const best = exact ?? (results[0] as Record<string, unknown>);
  const id = best?.id ?? best?.libraryId ?? best?.library_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function fetchDocs(libraryId: string, topic?: string): Promise<string | null> {
  let url = `${CONTEXT7_BASE}/libraries/${encodeURIComponent(libraryId)}/docs?tokens=${CACHE_TOKENS}`;
  if (topic) url += `&topic=${encodeURIComponent(topic)}`;

  const res = await fetchWithTimeout(url, TIMEOUT_MS);
  if (!res.ok) return null;

  const data = await res.json() as unknown;

  // Various possible shapes: { content: string }, { text: string }, { docs: string }, plain string
  if (typeof data === "string") return data.trim() || null;
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    for (const key of ["content", "text", "docs", "documentation", "body"]) {
      if (typeof obj[key] === "string" && (obj[key] as string).length > 0) {
        return (obj[key] as string).trim();
      }
    }
    // If it's an array of sections, join them
    const sections = extractArray(data, ["sections", "results", "items"]);
    if (sections && sections.length > 0) {
      return sections
        .map((s: Record<string, unknown>) => String(s.content ?? s.text ?? s.body ?? ""))
        .filter(Boolean)
        .join("\n\n")
        .trim() || null;
    }
  }
  return null;
}

/** fetch with an AbortController timeout */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Try several keys to extract an array from an API response. */
function extractArray(
  data: unknown,
  keys: string[]
): Array<Record<string, unknown>> | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(obj[key]) && (obj[key] as unknown[]).length > 0) {
      return obj[key] as Array<Record<string, unknown>>;
    }
  }
  if (Array.isArray(data) && data.length > 0) {
    return data as Array<Record<string, unknown>>;
  }
  return null;
}
