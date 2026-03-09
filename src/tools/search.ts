// ─── Web Search Tool ──────────────────────────────────────────────────────────
// Lightweight DuckDuckGo instant-answer search for workers.
// Used when a worker is stuck on package docs or unfamiliar APIs.

const DDG_API = "https://api.duckduckgo.com/";
const TIMEOUT_MS = 8000;

interface DdgTopic {
  Text?: string;
  FirstURL?: string;
}

interface DdgResponse {
  Abstract?: string;
  AbstractURL?: string;
  RelatedTopics?: DdgTopic[];
}

/**
 * Search DuckDuckGo's instant-answer API.
 * Returns a formatted string with an abstract + up to 3 related topics.
 * Never throws — returns empty string on any failure.
 */
export async function webSearch(query: string): Promise<string> {
  try {
    const url = new URL(DDG_API);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("no_html", "1");
    url.searchParams.set("skip_disambig", "1");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url.toString(), { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) return "";

    const data = (await res.json()) as DdgResponse;

    const parts: string[] = [];

    if (data.Abstract && data.Abstract.length > 0) {
      parts.push(`Summary: ${data.Abstract}`);
      if (data.AbstractURL) parts.push(`Source: ${data.AbstractURL}`);
    }

    const topics = (data.RelatedTopics ?? [])
      .filter((t): t is DdgTopic & { Text: string; FirstURL: string } =>
        Boolean(t.Text && t.FirstURL)
      )
      .slice(0, 3);

    if (topics.length > 0) {
      parts.push("\nRelated:");
      for (const t of topics) {
        parts.push(`- ${t.Text.slice(0, 120)} — ${t.FirstURL}`);
      }
    }

    return parts.join("\n");
  } catch {
    // Timeout, network error, parse error — all silently swallowed
    return "";
  }
}
