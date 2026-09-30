/**
 * Phase 6 — the web-search surface.
 *
 * `/api/search` existed before Phase 6 but had no user interface. Phase 6 adds
 * one, and this suite pins the contract that interface is written against:
 *
 *  - search is an authenticated capability (an anonymous caller must not spend
 *    metered provider quota);
 *  - the query is validated server-side, not merely in the browser;
 *  - a rate-limited or failed request returns a safe, human sentence rather
 *    than a stack trace or a driver message.
 *
 * It also pins the honest-reporting rule the UI depends on: when a provider
 * cannot be reached, the response says so in `error` instead of pretending to
 * be a successful search with zero results.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const OWNER = "usr_search_owner";
let sessionUser: string | null = OWNER;

vi.mock("@/lib/auth/guard", () => ({
  requireUser: async () => {
    if (!sessionUser) {
      const { ApiError } = await import("@/lib/api/errors");
      throw ApiError.unauthorized();
    }
    return { id: sessionUser, email: "u@nexa.invalid", name: null };
  },
}));

/** Flipped by the rate-limit tests. */
let limiterAllowed = true;
let limiterDeniedByStore = false;
vi.mock("@/lib/gateway/rate-limit-guard", () => ({
  checkSessionLimit: async () => ({
    allowed: limiterAllowed,
    deniedByStoreFailure: limiterDeniedByStore,
    retryAfterSeconds: 30,
    limit: 60,
    remaining: 0,
    storeUnavailable: limiterDeniedByStore,
  }),
  rateLimitHeaders: () => ({ "x-ratelimit-remaining": "0" }),
}));

/** What the search backend will answer with for the current test. */
let backend: Record<string, unknown> = {};
/** Every query the backend actually received. */
let backendCalls: Array<{ query: string; limit: number }> = [];

vi.mock("@/lib/search/web-search", () => ({
  WebSearchService: {
    search: async (query: string, limit: number) => {
      backendCalls.push({ query, limit });
      return backend;
    },
  },
}));

const { POST } = await import("@/app/api/search/route");

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  sessionUser = OWNER;
  limiterAllowed = true;
  limiterDeniedByStore = false;
  backendCalls = [];
  backend = {
    query: "nexa",
    provider: "brave",
    results: [
      { title: "A real result", url: "https://example.com/a", snippet: "Real snippet." },
    ],
    citations: [
      {
        title: "A real result",
        url: "https://example.com/a",
        snippet: "Real snippet.",
        sourceType: "web",
      },
    ],
  };
});

describe("POST /api/search — authentication", () => {
  it("rejects an anonymous caller with 401", async () => {
    sessionUser = null;
    const res = await POST(post({ query: "nexa" }));
    expect(res.status).toBe(401);
    // The metered backend must never be reached by an anonymous caller.
    expect(backendCalls).toHaveLength(0);
  });

  it("rejects an anonymous caller before the limiter is consulted", async () => {
    sessionUser = null;
    limiterAllowed = false;
    const res = await POST(post({ query: "nexa" }));
    // 401, not 429: an unauthenticated request must not be able to tell that a
    // quota exists, and must not consume one.
    expect(res.status).toBe(401);
  });
});

describe("POST /api/search — input validation", () => {
  it("rejects an empty query with 400", async () => {
    const res = await POST(post({ query: "   " }));
    expect(res.status).toBe(400);
    expect(backendCalls).toHaveLength(0);
  });

  it("rejects a missing query with 400", async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(400);
    expect(backendCalls).toHaveLength(0);
  });

  it("rejects a non-object body with 400", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify("just a string"),
      })
    );
    expect(res.status).toBe(400);
    expect(backendCalls).toHaveLength(0);
  });
});

describe("POST /api/search — rate limiting", () => {
  it("returns 429 with a safe message when the quota is exhausted", async () => {
    limiterAllowed = false;
    const res = await POST(post({ query: "nexa" }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("RATE_LIMITED");
    expect(String(body.error)).toMatch(/wait a moment/i);
    expect(backendCalls).toHaveLength(0);
  });

  it("distinguishes a limiter outage from an exhausted quota", async () => {
    // Failing closed is correct here, but the user must be told the difference:
    // "you did too much" and "our store is down" are different problems.
    limiterAllowed = false;
    limiterDeniedByStore = true;
    const res = await POST(post({ query: "nexa" }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(String(body.error)).toMatch(/temporarily unable/i);
  });
});

describe("POST /api/search — honest results", () => {
  it("returns exactly what the provider returned", async () => {
    const res = await POST(post({ query: "nexa" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe("brave");
    expect(body.results).toHaveLength(1);
    expect(body.results[0].url).toBe("https://example.com/a");
  });

  it("surfaces a provider failure in `error` rather than a fake empty result", async () => {
    // The UI renders this as "provider did not answer" instead of "no results".
    // If this regressed to a bare empty list, the product would be lying.
    backend = {
      query: "nexa",
      provider: "searxng",
      results: [],
      citations: [],
      error: "No search provider is configured or reachable.",
    };
    const res = await POST(post({ query: "nexa" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.results).toEqual([]);
  });

  it("never leaks a stack trace or driver message on failure", async () => {
    sessionUser = null;
    const res = await POST(post({ query: "nexa" }));
    const text = await res.text();
    expect(text).not.toMatch(/at .*\.ts:\d+/);
    expect(text).not.toMatch(/\/api\/search.*Error:/);
  });

  it("passes the caller's limit through to the backend", async () => {
    await POST(post({ query: "nexa", limit: 3 }));
    expect(backendCalls[0]).toEqual({ query: "nexa", limit: 3 });
  });
});


afterEach(() => {
  vi.restoreAllMocks();
});
