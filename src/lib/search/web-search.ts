import { Citation } from "@/types";

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

export interface WebSearchResponse {
  query: string;
  provider: string;
  results: SearchResultItem[];
  citations: Citation[];
  error?: string;
}

/**
 * Hard ceiling on how many results one search may return.
 *
 * Phase 5.3. Before this, `limit` flowed from the caller straight to the
 * provider: `/api/search` read `body.limit`, the `web_search` tool read
 * `input.limit`, and both passed it to `max_results` (Tavily) or `count=`
 * (Brave) with no upper bound. One request could therefore ask a metered
 * provider for an arbitrarily large result set.
 *
 * Enforced here rather than in each caller, on purpose: this is the only
 * function all three entry points (`/api/search`, and the `web_search` tool
 * reached from both `/api/tools` and `/api/agents`) share, so a single cap
 * here is a single choke point. Clamping at the call sites instead would be
 * three places to keep in sync — and the next caller would forget.
 *
 * 10 is above any legitimate interactive use and matches what a citation panel
 * can usefully display.
 */
const MAX_SEARCH_RESULTS = 10;

/** Clamp a caller-supplied result count into a sane range. */
export function clampSearchLimit(limit: unknown): number {
  const requested = typeof limit === "number" && Number.isFinite(limit) ? limit : 4;
  // Floored at 1 so a caller cannot ask for a negative or zero-sized page.
  return Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.floor(requested)));
}

export class WebSearchService {
  /**
   * Performs real web search if a provider is configured (SearXNG, Brave, Tavily)
   * If no provider is reachable, returns an honest status so the AI never fakes citations.
   *
   * `limit` is clamped by `clampSearchLimit` before it reaches any provider, so
   * this function is safe to call from any caller with untrusted input.
   */
  public static async search(query: string, limit = 4): Promise<WebSearchResponse> {
    // Phase 5.3: the single place the ceiling is applied. Clamping here (rather
    // than in `/api/search` and the `web_search` tool separately) guarantees
    // every current and future caller is covered, including `/api/agents`.
    const capped = clampSearchLimit(limit);
    const provider = process.env.SEARCH_PROVIDER || "searxng";
    const searchUrl = process.env.SEARCH_URL || process.env.SEARXNG_URL;
    const apiKey = process.env.SEARCH_API_KEY || process.env.BRAVE_API_KEY || process.env.TAVILY_API_KEY;

    // 1. Try SearXNG if configured
    if (searchUrl && (provider === "searxng" || !provider)) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        const url = `${searchUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(
          query
        )}&format=json&language=en`;
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (res.ok) {
          const data = (await res.json()) as {
            results?: Array<{ title: string; url: string; content: string }>;
          };
          const results = (data.results || []).slice(0, capped).map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.content,
          }));

          const citations: Citation[] = results.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            sourceType: "web",
          }));

          return {
            query,
            provider: "searxng",
            results,
            citations,
          };
        }
      } catch (err: unknown) {
        console.warn("SearXNG search error:", err);
      }
    }

    // 2. Try Tavily if API key is configured
    if (apiKey && (provider === "tavily" || (!searchUrl && apiKey.startsWith("tvly-")))) {
      try {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results: capped,
            search_depth: "basic",
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            results?: Array<{ title: string; url: string; content: string }>;
          };
          const results = (data.results || []).slice(0, capped).map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.content,
          }));
          const citations: Citation[] = results.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            sourceType: "web",
          }));
          return {
            query,
            provider: "tavily",
            results,
            citations,
          };
        }
      } catch (err: unknown) {
        console.warn("Tavily search error:", err);
      }
    }

    // 3. Try Brave Search if configured
    if (apiKey && provider === "brave") {
      try {
        const res = await fetch(
          `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${capped}`,
          {
            headers: {
              Accept: "application/json",
              "X-Subscription-Token": apiKey,
            },
          }
        );
        if (res.ok) {
          const data = (await res.json()) as {
            web?: { results?: Array<{ title: string; url: string; description: string }> };
          };
          const results = (data.web?.results || []).slice(0, capped).map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.description,
          }));
          const citations: Citation[] = results.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            sourceType: "web",
          }));
          return {
            query,
            provider: "brave",
            results,
            citations,
          };
        }
      } catch (err: unknown) {
        console.warn("Brave search error:", err);
      }
    }

    // Honest reporting when no web search provider is running/configured
    return {
      query,
      provider: "none",
      results: [],
      citations: [],
      error:
        "Web search is currently unavailable. No search provider (such as local SearXNG, Tavily, or Brave) is configured. Configure SEARCH_URL or SEARCH_API_KEY in .env or Settings.",
    };
  }
}
