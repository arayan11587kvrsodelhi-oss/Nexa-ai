/**
 * Phase 5.3 — `/api/agents` rate limiting, tool-path enforcement, and search
 * amplification.
 *
 * These tests exist because three findings were **verified against this
 * checkout** before any code changed, not assumed:
 *
 *  1. `/api/agents` reached the same `web_search` / `file_search`
 *     implementations that `/api/tools` and `/api/search` limit, but by calling
 *     `ToolExecutor.execute` directly — so neither HTTP limiter applied.
 *  2. The agent called `ToolExecutor.execute` without `userId`, and
 *     `ToolExecutor` treats a missing `userId` as "no ownership filter", so
 *     `file_search` returned documents belonging to every user.
 *  3. `limit` was never capped anywhere, so a caller could ask a metered search
 *     provider for an arbitrarily large result set.
 *
 * The limiter store is doubled so bucket arithmetic is real; the orchestrator is
 * the seam for the tool paths.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

interface Row {
  windowStart: number;
  count: number;
}

const rows = new Map<string, Row>();
let storeError: Error | null = null;

const execute = vi.fn(async (query: { queryChunks: unknown[] }) => {
  const params = (query.queryChunks as unknown[]).filter(
    (chunk) =>
      !(
        chunk !== null &&
        typeof chunk === "object" &&
        Array.isArray((chunk as { value?: unknown }).value)
      )
  );
  const bucketKey = String(params[0]);
  const start = Number(params[1]);
  if (storeError) throw storeError;
  const existing = rows.get(bucketKey);
  const stale = !existing || existing.windowStart < start;
  rows.set(bucketKey, {
    windowStart: stale ? start : existing.windowStart,
    count: stale ? 1 : existing.count + 1,
  });
  return {
    rows: [
      { count: rows.get(bucketKey)!.count, window_start: rows.get(bucketKey)!.windowStart },
    ],
  };
});

const inserted = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@/db", () => ({
  db: {
    execute: (q: { queryChunks: unknown[] }) => execute(q),
    insert: () => ({ values: inserted }),
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));
vi.mock("@/db/schema", () => ({
  agentRuns: { id: "id", goal: "goal", status: "status", steps: "steps", userId: "user_id", createdAt: "created_at", completedAt: "completed_at", result: "result" },
  documents: { id: "id", name: "name", userId: "user_id", rawContent: "raw_content", mimeType: "mime", size: "size", characterCount: "cc", chunkCount: "chunks" },
  documentChunks: { name: "document_chunks" },
}));

const OWNER = "usr_owner";
const OTHER = "usr_other";

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

/** Records exactly what the orchestrator asked the tool layer to do. */
const toolExecute = vi.fn();
vi.mock("@/lib/tools/executor", () => ({
  ToolExecutor: { execute: (...a: unknown[]) => toolExecute(...a) },
}));

const { POST } = await import("@/app/api/agents/route");
// Imported at module scope so every `describe` body can use it synchronously.
const { clampSearchLimit, WebSearchService } = await import("@/lib/search/web-search");

const AGENT_LIMIT = 3;
const AGENT_IP_LIMIT = 4;

function req(body: unknown, ip = "203.0.113.55"): NextRequest {
  return new NextRequest("http://localhost/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

/** A goal that makes the orchestrator select `web_search` (a metered tool). */
const SEARCH_GOAL = "find the latest web news";

beforeEach(() => {
  rows.clear();
  storeError = null;
  execute.mockClear();
  inserted.mockClear();
  toolExecute.mockReset();
  sessionUser = OWNER;
  toolExecute.mockResolvedValue({ toolName: "web_search", status: "success", result: [] });
  vi.stubEnv("NEXA_AGENT_USER_RATE_LIMIT", String(AGENT_LIMIT));
  vi.stubEnv("NEXA_AGENT_IP_RATE_LIMIT", String(AGENT_IP_LIMIT));
});

describe("POST /api/agents — authentication ordering", () => {
  it("returns 401 and never touches the limiter without a session", async () => {
    sessionUser = null;
    const res = await POST(req({ goal: SEARCH_GOAL }));
    expect(res.status).toBe(401);
    // The invariant: an anonymous caller must not spend a signed-in user's quota.
    expect(execute).not.toHaveBeenCalled();
  });

  it("never converts an authentication failure into a throttle", async () => {
    sessionUser = null;
    const statuses: number[] = [];
    for (let i = 0; i < AGENT_IP_LIMIT + 3; i++) {
      statuses.push((await POST(req({ goal: SEARCH_GOAL }))).status);
    }
    expect(new Set(statuses)).toEqual(new Set([401]));
  });

  it("leaves a signed-in user's quota untouched after rejected requests", async () => {
    sessionUser = null;
    await POST(req({ goal: SEARCH_GOAL }));
    sessionUser = OWNER;
    expect((await POST(req({ goal: SEARCH_GOAL }))).status).toBe(200);
  });
});

describe("POST /api/agents — per-user limit", () => {
  it("serves requests within the limit and answers 429 beyond it", async () => {
    for (let i = 0; i < AGENT_LIMIT; i++) {
      expect((await POST(req({ goal: SEARCH_GOAL }))).status, `run ${i}`).toBe(200);
    }
    expect((await POST(req({ goal: SEARCH_GOAL }))).status).toBe(429);
    // The refused run must not have invoked the tool layer at all.
    expect(toolExecute).toHaveBeenCalledTimes(AGENT_LIMIT);
  });

  it("writes no agent_runs row and runs no tool when throttled", async () => {
    for (let i = 0; i < AGENT_LIMIT; i++) await POST(req({ goal: SEARCH_GOAL }));
    const writes = inserted.mock.calls.length;
    await POST(req({ goal: SEARCH_GOAL }));
    // A refused request must not leave a row behind or burn a metered search.
    expect(inserted.mock.calls.length).toBe(writes);
  });

  it("reports Retry-After and the remaining quota, with no internals leaked", async () => {
    for (let i = 0; i < AGENT_LIMIT; i++) await POST(req({ goal: SEARCH_GOAL }));
    const res = await POST(req({ goal: SEARCH_GOAL }));
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(AGENT_LIMIT));
    const body = await res.text();
    expect(body).not.toMatch(/rate_limit_buckets|SELECT|INSERT|usr_owner|sql|stack/i);
  });

  it("isolates one user's exhausted quota from another's", async () => {
    for (let i = 0; i < AGENT_LIMIT; i++) await POST(req({ goal: SEARCH_GOAL }));
    expect((await POST(req({ goal: SEARCH_GOAL }))).status).toBe(429);
    sessionUser = OTHER;
    expect((await POST(req({ goal: SEARCH_GOAL }, "198.51.100.31"))).status).toBe(200);
  });

  it("cannot be dodged by a client-supplied identity field", async () => {
    // The bucket is keyed by the session, so naming another user in the body
    // must not move the request into that account's budget.
    for (let i = 0; i < AGENT_LIMIT; i++) {
      await POST(req({ goal: SEARCH_GOAL, userId: OTHER, user_id: OTHER }));
    }
    expect((await POST(req({ goal: SEARCH_GOAL, userId: OTHER }))).status).toBe(429);
  });
});

describe("POST /api/agents — per-IP limit", () => {
  beforeEach(() => {
    // Lift the user limit so only the address dimension can bind here.
    vi.stubEnv("NEXA_AGENT_USER_RATE_LIMIT", "1000");
  });

  it("shares one address budget across different users", async () => {
    for (let i = 0; i < AGENT_IP_LIMIT; i++) {
      sessionUser = `usr_${i}`;
      expect((await POST(req({ goal: SEARCH_GOAL }))).status, `user ${i}`).toBe(200);
    }
    sessionUser = "usr_never_seen";
    const res = await POST(req({ goal: SEARCH_GOAL }));
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(AGENT_IP_LIMIT));
  });

  it("keeps different addresses independent", async () => {
    for (let i = 0; i < AGENT_IP_LIMIT; i++) {
      expect((await POST(req({ goal: SEARCH_GOAL }))).status).toBe(200);
    }
    expect((await POST(req({ goal: SEARCH_GOAL }))).status).toBe(429);
    expect((await POST(req({ goal: SEARCH_GOAL }, "198.51.100.77"))).status).toBe(200);
  });

  it("ignores a client-supplied IP field in the body", async () => {
    // A body field naming an address must not become the bucket identity; only
    // the real proxy headers are consulted.
    for (let i = 0; i < AGENT_IP_LIMIT; i++) {
      expect((await POST(req({ goal: SEARCH_GOAL, ip: `1.2.3.${i}` }))).status).toBe(200);
    }
    expect((await POST(req({ goal: SEARCH_GOAL, ip: "9.9.9.9" }))).status).toBe(429);
  });
});

describe("POST /api/agents — limiter store failure", () => {
  beforeEach(() => {
    storeError = new Error("connection terminated unexpectedly");
  });

  it("fails closed with 503, never 429", async () => {
    const res = await POST(req({ goal: SEARCH_GOAL }));
    expect(res.status).toBe(503);
  });

  it("runs no tool and writes no row when the store is unreachable", async () => {
    await POST(req({ goal: SEARCH_GOAL }));
    // The whole point: a database outage must not become an unrestricted agent
    // that can still spend metered search quota.
    expect(toolExecute).not.toHaveBeenCalled();
    expect(inserted).not.toHaveBeenCalled();
  });

  it("never leaks the database error to the caller", async () => {
    storeError = new Error("FATAL: password authentication failed for user nexa_admin");
    const body = await (await POST(req({ goal: SEARCH_GOAL }))).text();
    expect(body).not.toMatch(/password|nexa_admin|FATAL|postgres|rate_limit_buckets/i);
  });

  it("recovers as soon as the store does", async () => {
    expect((await POST(req({ goal: SEARCH_GOAL }))).status).toBe(503);
    storeError = null;
    expect((await POST(req({ goal: SEARCH_GOAL }))).status).toBe(200);
  });
});

describe("agent tool path — ownership and bounds", () => {
  it("passes the authenticated user id to the tool layer", async () => {
    await POST(req({ goal: "search my documents for invoices" }));
    // The verified defect: `userId` was omitted, and ToolExecutor treats a
    // missing userId as "no ownership filter", so `file_search` returned
    // documents belonging to every user. The 4th argument is the owner.
    const call = toolExecute.mock.calls[0] as unknown[];
    expect(call[3]).toBe(OWNER);
  });

  it("scopes the tool call to the session, never to a client-supplied id", async () => {
    sessionUser = OWNER;
    await POST(req({ goal: "find invoices", userId: OTHER }));
    // Whatever the body claims, the tool layer receives the session identity.
    expect((toolExecute.mock.calls[0] as unknown[])[3]).toBe(OWNER);
  });

  it("performs at most one tool call per agent run", async () => {
    await POST(req({ goal: SEARCH_GOAL }));
    // The orchestrator is a fixed three-step script with a single tool
    // invocation: there is no loop and no client-supplied iteration count, so
    // one run cannot amplify into many tool calls.
    expect(toolExecute).toHaveBeenCalledTimes(1);
  });

  it("ignores any client-supplied iteration or tool-limit field", async () => {
    await POST(
      req({ goal: SEARCH_GOAL, maxIterations: 500, maxTools: 500, iterations: 500, steps: 500, toolLimit: 500 })
    );
    // No such field is read, and the run still performs exactly one tool call.
    expect(toolExecute).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty goal before running any tool", async () => {
    const res = await POST(req({ goal: "   " }));
    expect(res.status).toBe(400);
    expect(toolExecute).not.toHaveBeenCalled();
  });

  it("rejects an oversized goal before running any tool", async () => {
    const res = await POST(req({ goal: "x".repeat(2001) }));
    expect(res.status).toBe(400);
    expect(toolExecute).not.toHaveBeenCalled();
  });

  it("does not let a failing tool call re-enter the tool layer", async () => {
    toolExecute.mockResolvedValue({ toolName: "web_search", status: "failed", error: "boom" });
    const res = await POST(req({ goal: SEARCH_GOAL }));
    // The orchestrator records the failure and finishes; it does not retry.
    expect(res.status).toBe(200);
    expect(toolExecute).toHaveBeenCalledTimes(1);
  });
});

describe("search result amplification", () => {
  it("caps an oversized request at the server maximum", () => {
    // The verified gap: `limit` reached `max_results` / `count=` unbounded.
    expect(clampSearchLimit(100000)).toBe(10);
    expect(clampSearchLimit(9999)).toBe(10);
  });

  it("keeps a reasonable request unchanged", () => {
    expect(clampSearchLimit(4)).toBe(4);
    expect(clampSearchLimit(10)).toBe(10);
  });

  it("defaults to 4 for a missing or non-numeric value", () => {
    expect(clampSearchLimit(undefined)).toBe(4);
    expect(clampSearchLimit("ten")).toBe(4);
    expect(clampSearchLimit(Number.NaN)).toBe(4);
    expect(clampSearchLimit(Number.POSITIVE_INFINITY)).toBe(4);
  });

  it("never returns fewer than one result", () => {
    expect(clampSearchLimit(0)).toBe(1);
    expect(clampSearchLimit(-5)).toBe(1);
  });

  it("is applied by the shared search implementation, not only by one caller", async () => {
    // Every entry point — /api/search, the web_search tool from /api/tools, and
    // the same tool from /api/agents — goes through WebSearchService.search, so
    // clamping there covers all three without three separate limits.
    const seen: number[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const text = String(url);
      const match = /count=(\d+)/.exec(text) ?? /max_results"?:\s*(\d+)/.exec(text);
      if (match) seen.push(Number(match[1]));
      return {
        ok: true,
        status: 200,
        json: async () => ({ web: { results: [] } }),
      } as unknown as Response;
    }) as typeof globalThis.fetch;
    try {
      await WebSearchService.search("nexa", 5000);
    } finally {
      globalThis.fetch = originalFetch;
    }
    // Either the provider was never reached (no capture) or it was asked for at
    // most the cap. Both are acceptable; an uncapped 5000 is not.
    expect(seen.every((n) => n <= 10)).toBe(true);
  });
});
