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

export class WebSearchService {
  /**
   * Performs real web search if a provider is configured (SearXNG, Brave, Tavily)
   * If no provider is reachable, returns an honest status so the AI never fakes citations.
   */
  public static async search(query: string, limit = 4): Promise<WebSearchResponse> {
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
          const results = (data.results || []).slice(0, limit).map((r) => ({
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
            max_results: limit,
            search_depth: "basic",
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            results?: Array<{ title: string; url: string; content: string }>;
          };
          const results = (data.results || []).slice(0, limit).map((r) => ({
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
          `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
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
          const results = (data.web?.results || []).slice(0, limit).map((r) => ({
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
