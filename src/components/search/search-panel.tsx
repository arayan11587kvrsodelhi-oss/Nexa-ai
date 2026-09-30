"use client";
import { useState } from "react";
import { Search as SearchIcon, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, SkeletonLines } from "@/components/ui/feedback";
import type { SearchResultItem, WebSearchResponse } from "@/types";

/** Long enough to be a real question, short enough to be a search box. */
const MAX_QUERY = 500;
/** Matches the server's clamp ceiling; the server enforces it regardless. */
const DEFAULT_LIMIT = 5;

type Status = "idle" | "searching" | "done" | "failed";

/**
 * Host shown next to a result.
 *
 * Rendering the bare URL would push a very long string into a narrow column, so
 * the host is what the eye actually scans for. This is presentation only — the
 * link still points at the full URL the provider returned.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // A provider may return something unparseable. Show it verbatim rather
    // than inventing a host.
    return url;
  }
}

function ResultRow({ item, index }: { item: SearchResultItem; index: number }) {
  return (
    <li className="rounded-panel border px-4 py-3" style={{ borderColor: "var(--nexa-border)" }}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 font-mono text-[10px] nexa-muted">{index + 1}.</span>
        <div className="min-w-0 flex-1">
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="group inline-flex max-w-full items-center gap-1.5 text-sm font-medium nexa-text hover:underline"
          >
            <span className="truncate">{item.title || item.url}</span>
            <ExternalLink
              className="size-3 shrink-0 nexa-muted transition-colors group-hover:nexa-accent-text"
              aria-hidden
            />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
          <p className="mt-0.5 truncate font-mono text-[10px] nexa-muted">{hostOf(item.url)}</p>
          {item.snippet ? (
            <p className="mt-1.5 text-xs leading-relaxed nexa-muted">{item.snippet}</p>
          ) : null}
        </div>
      </div>
    </li>
  );
}


export function SearchPanel() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [response, setResponse] = useState<WebSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trimmed = query.trim();
  const tooLong = trimmed.length > MAX_QUERY;

  const search = async (q: string) => {
    setStatus("searching");
    setError(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q, limit: DEFAULT_LIMIT }),
      });
      // The server's sanitized error layer already returns a safe sentence; we
      // surface it verbatim rather than inventing one or showing a status code.
      const data = (await res.json().catch(() => null)) as
        | (Partial<WebSearchResponse> & { error?: unknown })
        | null;

      if (!res.ok) {
        setError(
          typeof data?.error === "string" ? data.error : `Search failed (HTTP ${res.status}).`
        );
        setResponse(null);
        setStatus("failed");
        return;
      }
      if (!data) {
        setError("The server returned an unreadable response.");
        setResponse(null);
        setStatus("failed");
        return;
      }
      setResponse({
        query: data.query ?? q,
        provider: data.provider ?? "unknown",
        results: Array.isArray(data.results) ? data.results : [],
        citations: Array.isArray(data.citations) ? data.citations : [],
        error: typeof data.error === "string" ? data.error : undefined,
      });
      setStatus("done");
    } catch {
      setError("Could not reach the search service.");
      setResponse(null);
      setStatus("failed");
    }
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed || tooLong) return;
    void search(trimmed);
  };

  const results = response?.results ?? [];
  // A backend that could not be reached returns `error` alongside zero
  // results. Showing "no results" there would be a lie about what happened.
  const providerError = response?.error;


  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 py-6">
      <div>
        <h1 className="text-base font-semibold nexa-text">Web search</h1>
        <p className="mt-1 text-xs nexa-muted">
          Queries the configured search provider. Results shown are exactly what the
          provider returned.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-2" noValidate>
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="search-query" className="sr-only">
              Search query
            </label>
            <input
              id="search-query"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={MAX_QUERY}
              placeholder="Ask the web something…"
              aria-invalid={tooLong || undefined}
              aria-describedby={tooLong ? "search-query-hint" : undefined}
              className="nexa-raised w-full rounded-control border px-3 py-2 text-sm nexa-text outline-none placeholder:nexa-muted"
              style={{ borderColor: "var(--nexa-border-strong)" }}
            />
          </div>
          <Button type="submit" variant="primary" loading={status === "searching"}>
            Search
          </Button>
        </div>
        {tooLong ? (
          <p
            id="search-query-hint"
            className="text-[11px]"
            style={{ color: "var(--nexa-warn-strong)" }}
          >
            Keep the query under {MAX_QUERY} characters.
          </p>
        ) : null}
      </form>

      {status === "searching" ? (
        <div role="status" aria-label="Searching">
          <SkeletonLines count={4} />
        </div>
      ) : null}

      {error ? (
        <ErrorState
          title="Search unavailable"
          message={error}
          onRetry={trimmed && !tooLong ? () => void search(trimmed) : undefined}
        />
      ) : null}

      {providerError && !error ? (
        <ErrorState
          tone="warning"
          title={`Search provider "${response?.provider ?? "unknown"}" did not answer`}
          message={providerError}
        />
      ) : null}

      {status === "done" && !providerError && results.length === 0 ? (
        <EmptyState
          icon={<SearchIcon className="size-4" aria-hidden />}
          title="No results"
          description={`The ${response?.provider ?? "search provider"} returned no matches for this query.`}
        />
      ) : null}

      {status === "done" && !providerError && results.length > 0 ? (
        <>
          <div className="flex items-center gap-2">
            <p className="text-xs nexa-muted">
              {results.length} result{results.length === 1 ? "" : "s"}
            </p>
            <Badge tone="accent">{response?.provider}</Badge>
          </div>
          <ul className="flex flex-col gap-2">
            {results.map((item, i) => (
              <ResultRow key={`${item.url}-${i}`} item={item} index={i} />
            ))}
          </ul>
        </>
      ) : null}

      {status === "idle" ? (
        <EmptyState
          icon={<SearchIcon className="size-4" aria-hidden />}
          title="No search run yet"
          description="Enter a query above. NEXA only shows results the configured provider actually returned."
        />
      ) : null}
    </div>
  );
}
