/**
 * Phase 5.1 - the `/api/tools` and `/api/search` rate-limit audit.
 *
 * Both routes were audited by reading their implementations rather than by
 * assuming they were "unthrottled like the others". Both turned out to reach a
 * metered third-party API, so both are limited. These tests pin the decisions
 * and, critically, the *ordering* property the whole limiter rests on: an
 * unauthenticated caller gets 401 and never spends a valid user's quota.
 *
 * The database is replaced by a store double so bucket behaviour is real (keys
 * are formed exactly as production forms them) while staying fast.
 *
 * NOTE: `/api/chat` lives in `chat-rate-limit.test.ts`; it needs a different
 * set of module doubles (provider, gateway, RAG) and is kept separate so these
 * seams stay minimal.
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

vi.mock("@/db", () => ({ db: { execute: (q: { queryChunks: unknown[] }) => execute(q) } }));

const OWNER = "usr_owner";
const OTHER = "usr_other";

/** The session decides the user; a test moves the cookie and nothing else. */
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

/** The work these routes actually do, counted so "did we serve it?" is provable. */
const executeTool = vi.fn();
vi.mock("@/lib/tools/executor", () => ({
  ToolExecutor: { execute: (...a: unknown[]) => executeTool(...a) },
}));
vi.mock("@/lib/tools/registry", () => ({
  ToolRegistry: { getAll: () => [{ name: "calculator" }] },
}));

const search = vi.fn();
vi.mock("@/lib/search/web-search", () => ({
  WebSearchService: { search: (...a: unknown[]) => search(...a) },
}));

// The tool executor imports the schema; the search route reaches no database of
// its own, so neither is exercised here.
vi.mock("@/db/schema", () => ({
  toolCalls: { name: "tool_calls" },
  conversations: { id: "id", userId: "user_id" },
}));

const { POST: TOOLS_POST, GET: TOOLS_GET } = await import("@/app/api/tools/route");
const { POST: SEARCH_POST } = await import("@/app/api/search/route");

const TOOL_LIMIT = 3;
const SEARCH_LIMIT = 2;

function req(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "nexa_session=whatever" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  rows.clear();
  storeError = null;
  execute.mockClear();
  sessionUser = OWNER;
  executeTool.mockResolvedValue({ toolName: "calculator", status: "success" });
  search.mockResolvedValue({ query: "q", provider: "searxng", results: [], citations: [] });
  vi.stubEnv("NEXA_TOOLS_RATE_LIMIT", String(TOOL_LIMIT));
  vi.stubEnv("NEXA_SEARCH_RATE_LIMIT", String(SEARCH_LIMIT));
});


describe("POST /api/tools", () => {
  it("serves requests within the limit and answers 429 beyond it", async () => {
    for (let i = 0; i < TOOL_LIMIT; i++) {
      const res = await TOOLS_POST(req("/api/tools", { toolName: "calculator", input: {} }));
      expect(res.status, `request ${i}`).toBe(200);
    }
    const refused = await TOOLS_POST(req("/api/tools", { toolName: "calculator", input: {} }));
    expect(refused.status).toBe(429);
    // The refused request must not have run the tool.
    expect(executeTool).toHaveBeenCalledTimes(TOOL_LIMIT);
  });

  it("reports Retry-After and the remaining quota", async () => {
    for (let i = 0; i < TOOL_LIMIT; i++) {
      await TOOLS_POST(req("/api/tools", { toolName: "calculator", input: {} }));
    }
    const res = await TOOLS_POST(req("/api/tools", { toolName: "calculator", input: {} }));
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(TOOL_LIMIT));
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("returns 401 before the limiter is ever consulted", async () => {
    sessionUser = null;
    const res = await TOOLS_POST(req("/api/tools", { toolName: "calculator", input: {} }));
    expect(res.status).toBe(401);
    // The security-relevant assertion: an anonymous caller cannot consume a
    // valid user's quota, so the store was never touched.
    expect(execute).not.toHaveBeenCalled();
  });

  it("keys the bucket by the server-resolved user, not by what the client sends", async () => {
    // A body field naming a different user is ignored entirely; the session
    // decides. This user exhausts their own bucket and nobody else's.
    for (let i = 0; i < TOOL_LIMIT; i++) {
      await TOOLS_POST(req("/api/tools", { toolName: "calculator", input: {}, userId: OTHER }));
    }
    expect((await TOOLS_POST(req("/api/tools", { toolName: "calculator" }))).status).toBe(429);

    sessionUser = OTHER;
    // A different account still has its full allowance.
    expect((await TOOLS_POST(req("/api/tools", { toolName: "calculator" }))).status).toBe(200);
  });

  it("does not charge a read-only GET against the invocation quota", async () => {
    // The audit found GET serves a static in-memory registry: no network, no
    // database. It must stay unlimited, or every page load would cost a
    // database write to constrain nothing.
    for (let i = 0; i < TOOL_LIMIT * 3; i++) {
      expect((await TOOLS_GET(req("/api/tools", {}))).status).toBe(200);
    }
    expect(execute).not.toHaveBeenCalled();
    // And the POST budget is untouched by all that reading.
    for (let i = 0; i < TOOL_LIMIT; i++) {
      expect((await TOOLS_POST(req("/api/tools", { toolName: "calculator" }))).status).toBe(200);
    }
  });

  it("leaks no limiter internals in the refusal body", async () => {
    for (let i = 0; i < TOOL_LIMIT; i++) {
      await TOOLS_POST(req("/api/tools", { toolName: "calculator" }));
    }
    const body = await (await TOOLS_POST(req("/api/tools", { toolName: "calculator" }))).text();
    expect(body).not.toMatch(/rate_limit_buckets|SELECT|INSERT|sql|usr_owner|stack/i);
  });
});

describe("POST /api/search", () => {
  it("serves requests within the limit and answers 429 beyond it", async () => {
    for (let i = 0; i < SEARCH_LIMIT; i++) {
      const res = await SEARCH_POST(req("/api/search", { query: "nexa" }));
      expect(res.status, `request ${i}`).toBe(200);
    }
    expect((await SEARCH_POST(req("/api/search", { query: "nexa" }))).status).toBe(429);
    // No upstream call for the refused request: the whole point is that the
    // metered credential is not spent.
    expect(search).toHaveBeenCalledTimes(SEARCH_LIMIT);
  });

  it("returns 401 before the limiter is ever consulted", async () => {
    sessionUser = null;
    const res = await SEARCH_POST(req("/api/search", { query: "nexa" }));
    expect(res.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("keeps one user's exhausted quota from affecting another", async () => {
    for (let i = 0; i < SEARCH_LIMIT; i++) {
      await SEARCH_POST(req("/api/search", { query: "nexa" }));
    }
    expect((await SEARCH_POST(req("/api/search", { query: "nexa" }))).status).toBe(429);
    sessionUser = OTHER;
    expect((await SEARCH_POST(req("/api/search", { query: "nexa" }))).status).toBe(200);
  });

  it("charges quota before validating the body, so bad input cannot probe the provider free", async () => {
    // The body is parsed after the limit is consumed, so a malformed request
    // cannot be replayed to make unlimited upstream calls.
    expect((await SEARCH_POST(req("/api/search", { query: "nexa" }))).status).toBe(200);
    const rowsBefore = rows.get("session:search:" + OWNER)?.count;
    await SEARCH_POST(req("/api/search", {}));
    expect(rows.get("session:search:" + OWNER)?.count).toBe((rowsBefore ?? 0) + 1);
  });

  it("leaks no limiter internals in the refusal body", async () => {
    for (let i = 0; i < SEARCH_LIMIT; i++) {
      await SEARCH_POST(req("/api/search", { query: "nexa" }));
    }
    const res = await SEARCH_POST(req("/api/search", { query: "nexa" }));
    const body = await res.text();
    expect(body).not.toMatch(/rate_limit_buckets|SELECT|INSERT|sql|usr_owner|stack/i);
  });
});

describe("limiter store outage on the session routes", () => {
  it("fails closed rather than allowing unlimited metered spend", async () => {
    storeError = new Error("connection terminated unexpectedly");
    const res = await SEARCH_POST(req("/api/search", { query: "nexa" }));
    expect(res.status).toBe(429);
    // Denied before the upstream provider was contacted at all.
    expect(search).not.toHaveBeenCalled();
  });

  it("does not report a store outage as an exhausted quota", async () => {
    storeError = new Error("FATAL: password authentication failed for user nexa_admin");
    const res = await TOOLS_POST(req("/api/tools", { toolName: "calculator" }));
    const body = await res.json();
    // A distinct message: a broken limiter is an incident, not ordinary
    // throttling, and an operator must be able to tell them apart.
    expect(body.error).not.toMatch(/Too many/i);
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("never exposes the database error text to the caller", async () => {
    storeError = new Error("FATAL: password authentication failed for user nexa_admin");
    const res = await SEARCH_POST(req("/api/search", { query: "nexa" }));
    const body = await res.text();
    expect(body).not.toMatch(/password|nexa_admin|FATAL/i);
  });

  it("sends Retry-After but no misleading quota headers", async () => {
    storeError = new Error("down");
    const res = await SEARCH_POST(req("/api/search", { query: "nexa" }));
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    // There is no meaningful quota to report while the store is unreachable.
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
  });
});
