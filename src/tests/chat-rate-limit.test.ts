/**
 * Phase 5.2 — `POST /api/chat` abuse and quota protection.
 *
 * The audit found what the Phase 5 report implied but the code did not contain:
 * `/api/chat` had **no rate limiter at all** and **no `AbortSignal`
 * propagation**. It was the single largest unprotected upstream-cost path in the
 * application. These tests pin the fixed ordering and the failure semantics,
 * because both are easy to break silently.
 *
 * The limiter store is doubled so bucket arithmetic is real (bucket keys are
 * formed exactly as production forms them) while staying fast and
 * deterministic. The provider, database and session are the seams.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

interface Row {
  windowStart: number;
  count: number;
}

const rows = new Map<string, Row>();
let storeError: Error | null = null;
/** Injected latency, used to interleave concurrent requests deterministically. */
let storeLatencyTicks = 0;

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
  if (storeLatencyTicks > 0) await new Promise((r) => setTimeout(r, storeLatencyTicks));
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

/**
 * The route writes conversation and message rows. Counting them proves a
 * throttled or malformed request performed no database work.
 */
const inserted = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@/db", () => ({
  db: {
    execute: (q: { queryChunks: unknown[] }) => execute(q),
    insert: () => ({ values: inserted }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

vi.mock("@/db/schema", () => ({
  conversations: { id: "id", userId: "user_id", title: "title", model: "model" },
  messages: { id: "id", conversationId: "conversation_id" },
  toolCalls: { name: "tool_calls" },
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

/** The expensive work. Every assertion about cost is a count on this. */
const streamChat = vi.fn();
vi.mock("@/lib/gateway/gateway", () => ({
  NexaGateway: { streamChat: (...a: unknown[]) => streamChat(...a) },
}));
vi.mock("@/lib/ai/inference", () => ({
  InferenceService: { resolveActiveProviderType: async () => "ollama" },
}));
vi.mock("@/lib/ai/router", () => ({
  ModelRouter: {
    route: () => ({
      modelId: "m",
      profile: "BALANCED",
      provider: "ollama",
      reason: "default",
    }),
  },
}));
vi.mock("@/lib/ai/providers/factory", () => ({ describeProvider: () => "Ollama" }));
vi.mock("@/lib/ai/provider-errors", () => ({ isProviderError: () => false }));
vi.mock("@/lib/rag/retriever", () => ({
  RAGRetriever: { retrieveRelevantChunks: async () => [] },
}));
vi.mock("@/lib/search/web-search", () => ({
  WebSearchService: {
    search: async () => ({ provider: "none", results: [], citations: [] }),
  },
}));
// Every MemoryService method the route actually calls. A missing one throws
// inside the request and surfaces as an opaque 500, which is why the full
// surface is declared rather than a single catch-all.
vi.mock("@/lib/memory/memory-service", () => ({
  MemoryService: {
    detectExplicitMemoryRequest: () => null,
    storeMemory: async () => undefined,
    getActiveMemories: async () => [],
    formatForPrompt: () => "",
  },
}));
vi.mock("@/lib/security/audit", () => ({ AuditLogger: { log: async () => undefined } }));
vi.mock("@/lib/tools/executor", () => ({ ToolExecutor: { execute: vi.fn() } }));

const { POST } = await import("@/app/api/chat/route");

const USER_LIMIT = 3;
const IP_LIMIT = 4;

function req(body: unknown, ip = "203.0.113.10", signal?: AbortSignal): NextRequest {
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

const VALID = { messages: [{ role: "user" as const, content: "hello" }] };

/**
 * Send a request and read the whole body.
 *
 * This is required, not cosmetic: the route opens the SSE stream and performs
 * the provider call inside the writer's async loop, so that loop only advances
 * once the body is consumed. Asserting on the provider without draining would
 * silently observe zero calls.
 */
async function send(body: unknown, ip = "203.0.113.10", signal?: AbortSignal): Promise<Response> {
  const res = await POST(req(body, ip, signal));
  await res.text().catch(() => undefined);
  return res;
}

beforeEach(() => {
  rows.clear();
  storeError = null;
  storeLatencyTicks = 0;
  execute.mockClear();
  inserted.mockClear();
  streamChat.mockReset();
  sessionUser = OWNER;
  // The shape a real provider yields: a token, then a terminal `done`.
  streamChat.mockImplementation(async function* () {
    yield { type: "token", content: "hi" };
    yield {
      type: "done",
      data: { model: "m", provider: "ollama", routing: { fallbackUsed: false } },
    };
  });
  vi.stubEnv("NEXA_CHAT_USER_RATE_LIMIT", String(USER_LIMIT));
  vi.stubEnv("NEXA_CHAT_IP_RATE_LIMIT", String(IP_LIMIT));
});

describe("POST /api/chat — authentication ordering", () => {
  it("returns 401 and never touches the limiter without a session", async () => {
    sessionUser = null;
    const res = await POST(req(VALID));
    expect(res.status).toBe(401);
    // The invariant the whole limiter rests on: an anonymous caller must not be
    // able to spend a valid user's quota.
    expect(execute).not.toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("returns 401 rather than 429 for an unauthenticated flood", async () => {
    sessionUser = null;
    const statuses: number[] = [];
    for (let i = 0; i < IP_LIMIT + 3; i++) {
      statuses.push((await POST(req(VALID))).status);
    }
    // Authentication failures are never converted into a throttle: doing so
    // would tell an unauthenticated client it is merely sending too fast.
    expect(new Set(statuses)).toEqual(new Set([401]));
  });

  it("leaves a signed-in user's quota untouched after rejected requests", async () => {
    sessionUser = null;
    await POST(req(VALID));
    await POST(req(VALID));
    // Now sign in: the full allowance must still be available.
    sessionUser = OWNER;
    expect((await POST(req(VALID))).status).toBe(200);
  });
});

describe("POST /api/chat — per-user limit", () => {
  it("serves requests within the limit and answers 429 beyond it", async () => {
    for (let i = 0; i < USER_LIMIT; i++) {
      expect((await send(VALID)).status, `request ${i}`).toBe(200);
    }
    const refused = await send(VALID);
    expect(refused.status).toBe(429);
    // The refused request must not have reached the provider.
    expect(streamChat).toHaveBeenCalledTimes(USER_LIMIT);
  });

  it("reports Retry-After and the remaining quota, but no limiter internals", async () => {
    for (let i = 0; i < USER_LIMIT; i++) await send(VALID);
    const res = await POST(req(VALID));
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(USER_LIMIT));
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    const body = await res.text();
    expect(body).not.toMatch(/rate_limit_buckets|SELECT|INSERT|usr_owner|sql|stack/i);
  });

  it("performs no database write and starts no stream when throttled", async () => {
    for (let i = 0; i < USER_LIMIT; i++) await send(VALID);
    const writesBefore = inserted.mock.calls.length;
    const providerCalls = streamChat.mock.calls.length;
    const res = await send(VALID);
    // A throttled request must be refused before any conversation/message row
    // is created, and before any SSE body is produced.
    expect(inserted.mock.calls.length).toBe(writesBefore);
    expect(streamChat.mock.calls.length).toBe(providerCalls);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("isolates one user's exhausted quota from another's", async () => {
    for (let i = 0; i < USER_LIMIT; i++) await send(VALID);
    expect((await send(VALID)).status).toBe(429);
    sessionUser = OTHER;
    // A different account has its own bucket and a different address below, so
    // it is entirely unaffected by the first account's exhaustion.
    expect((await send(VALID, "198.51.100.7")).status).toBe(200);
  });
});

describe("POST /api/chat — per-IP limit", () => {
  beforeEach(() => {
    // Lift the per-user limit so the *address* dimension is the only one that
    // can bind in this block; otherwise the tests below would be measuring the
    // user limit and would prove nothing about IP handling.
    vi.stubEnv("NEXA_CHAT_USER_RATE_LIMIT", "1000");
  });

  it("shares one address budget across different users", async () => {
    for (let i = 0; i < IP_LIMIT; i++) {
      sessionUser = `usr_${i}`;
      expect((await send(VALID)).status, `user ${i}`).toBe(200);
    }
    // A user whose own bucket is completely empty is still refused, because the
    // address budget is shared. That is the point of the second dimension.
    sessionUser = "usr_never_seen";
    const res = await POST(req(VALID));
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(IP_LIMIT));
    await res.text();
  });

  it("keeps different addresses independent", async () => {
    for (let i = 0; i < IP_LIMIT; i++) expect((await send(VALID)).status).toBe(200);
    expect((await send(VALID)).status).toBe(429);
    // A different source address has a separate budget.
    expect((await send(VALID, "198.51.100.99")).status).toBe(200);
  });

  it("collapses headerless requests into one shared bucket", async () => {
    // Stripping the proxy headers must not buy extra quota: those requests all
    // land in the `unknown` bucket, which is more restrictive, not less.
    const bare = (): NextRequest =>
      new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(VALID),
      });
    for (let i = 0; i < IP_LIMIT; i++) {
      const res = await POST(bare());
      expect(res.status, `request ${i}`).toBe(200);
      await res.text();
    }
    const refused = await POST(bare());
    expect(refused.status).toBe(429);
    await refused.text();
  });

  it("ignores a spoofed header that is not a usable address", async () => {
    // A non-address value cannot be used to mint a fresh bucket per request.
    for (let i = 0; i < IP_LIMIT; i++) {
      expect((await send(VALID, "not-an-ip")).status).toBe(200);
    }
    expect((await send(VALID, "not-an-ip")).status).toBe(429);
  });
});

describe("POST /api/chat — limiter store failure", () => {
  beforeEach(() => {
    storeError = new Error("connection terminated unexpectedly");
  });

  it("fails closed with 503, never 429", async () => {
    const res = await send(VALID);
    // 429 would falsely tell the client it is merely throttled and would hide
    // a real incident behind ordinary-looking throttling.
    expect(res.status).toBe(503);
  });

  it("never calls the provider when the store is unreachable", async () => {
    await send(VALID);
    // The single most important assertion: a database outage must not become
    // unlimited inference.
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("writes nothing to the database when the store is unreachable", async () => {
    await send(VALID);
    expect(inserted).not.toHaveBeenCalled();
  });

  it("does not report an outage as an exhausted quota", async () => {
    const res = await POST(req(VALID));
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).not.toMatch(/too quickly/i);
    expect(body.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("sends Retry-After but no misleading quota headers", async () => {
    const res = await POST(req(VALID));
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    // There is no meaningful quota to report while the store cannot be read.
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    await res.text();
  });

  it("never leaks the database error to the caller", async () => {
    storeError = new Error("FATAL: password authentication failed for user nexa_admin");
    const body = await (await POST(req(VALID))).text();
    expect(body).not.toMatch(/password|nexa_admin|FATAL|postgres|rate_limit_buckets/i);
  });

  it("recovers as soon as the store does", async () => {
    expect((await send(VALID)).status).toBe(503);
    storeError = null;
    expect((await send(VALID)).status).toBe(200);
  });
});

describe("POST /api/chat — streaming and SSE contract", () => {
  it("preserves the SSE contract for an allowed request", async () => {
    const res = await POST(req(VALID));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const body = await res.text();
    // Every frame keeps the existing `data: {json}\n\n` framing and names.
    expect(body).toMatch(/data: \{"type":"token","content":"hi"\}/);
    expect(body).toMatch(/data: \{"type":"done"/);
    expect(streamChat).toHaveBeenCalledTimes(1);
  });

  it("passes a real AbortSignal to the provider", async () => {
    await send(VALID);
    // Before Phase 5.2 the route passed no signal at all, so a client that
    // disconnected left the model generating to completion.
    const request = streamChat.mock.calls[0]?.[0] as { signal?: AbortSignal };
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.signal?.aborted).toBe(false);
  });

  it("aborts the provider when the client disconnects", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    streamChat.mockImplementation(async function* (r: { signal?: AbortSignal }) {
      seen = r.signal;
      // The client hangs up mid-generation.
      controller.abort();
      yield { type: "token", content: "partial" };
      yield {
        type: "done",
        data: { model: "m", provider: "ollama", routing: { fallbackUsed: false } },
      };
    });
    await send(VALID, "203.0.113.10", controller.signal);
    // Cancellation reaches the provider, so upstream work stops instead of
    // completing for output nobody will read.
    expect(seen?.aborted).toBe(true);
  });

  it("does not refund quota when a request is aborted", async () => {
    const controller = new AbortController();
    streamChat.mockImplementation(async function* () {
      controller.abort();
      yield { type: "token", content: "partial" };
      yield {
        type: "done",
        data: { model: "m", provider: "ollama", routing: { fallbackUsed: false } },
      };
    });
    for (let i = 0; i < USER_LIMIT; i++) {
      await send(VALID, "203.0.113.10", controller.signal);
    }
    // Aborting must not become a way to obtain extra attempts: the next request
    // is still throttled.
    expect((await send(VALID)).status).toBe(429);
  });
});

describe("POST /api/chat — malformed requests", () => {
  it("never calls the provider for an empty messages array", async () => {
    const res = await send({ messages: [] });
    expect(res.status).toBe(400);
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("never calls the provider for a malformed body", async () => {
    const broken = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
      body: "{not json",
    });
    const res = await POST(broken);
    expect(res.status).toBeGreaterThanOrEqual(400);
    await res.text().catch(() => undefined);
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("still charges quota for a malformed body, so garbage is not free", async () => {
    // Charging before validation means an attacker cannot send unlimited
    // malformed bodies to force unbounded database writes.
    for (let i = 0; i < USER_LIMIT; i++) {
      await send({ messages: [] });
    }
    expect((await send({ messages: [] })).status).toBe(429);
  });

  it("keeps a validation failure distinguishable from a throttle", async () => {
    const invalid = await send({ messages: [] });
    expect(invalid.status).toBe(400);
    for (let i = 0; i < USER_LIMIT; i++) await send(VALID);
    const throttled = await send(VALID);
    expect(throttled.status).toBe(429);
    // Different statuses, so a client can tell "fix your request" from "slow down".
    expect(invalid.status).not.toBe(throttled.status);
  });
});

describe("POST /api/chat — concurrency", () => {
  it("admits at most the limit when many identical requests race", async () => {
    storeLatencyTicks = 2;
    const results = await Promise.all(
      Array.from({ length: USER_LIMIT * 4 }, async () => {
        const res = await POST(req(VALID));
        await res.text().catch(() => undefined);
        return res.status;
      })
    );
    const allowed = results.filter((s) => s === 200).length;
    // The atomic upsert serialises on the row lock, so a read-then-write
    // limiter (which would over-admit) is not what is running here.
    expect(allowed).toBe(USER_LIMIT);
    expect(streamChat).toHaveBeenCalledTimes(USER_LIMIT);
  });

  it("charges one unit per dimension, not one per policy", async () => {
    await send(VALID);
    expect(rows.get(`chat:user:${OWNER}`)?.count).toBe(1);
    expect(rows.get("v1:ip:203.0.113.10")?.count).toBe(1);
  });
});
