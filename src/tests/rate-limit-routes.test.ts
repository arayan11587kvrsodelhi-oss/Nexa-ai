/**
 * Rate limiting on the `/v1` surface — route-level behaviour.
 *
 * The security-relevant property is *ordering*: authentication runs before the
 * limiter. That is what guarantees an invalid or revoked key receives 401 and
 * can never spend a valid key's quota. These tests drive the real guard and the
 * real route handlers, with only the database replaced by a store double.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

interface Row {
  windowStart: number;
  count: number;
}

const rows = new Map<string, Row>();
let storeError: Error | null = null;

const execute = vi.fn(async (query: { queryChunks: unknown[] }) => {
  const params = (query.queryChunks as unknown[]).filter(
    (chunk) =>
      !(chunk !== null && typeof chunk === "object" && Array.isArray((chunk as { value?: unknown }).value))
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
  return { rows: [{ count: rows.get(bucketKey)!.count, window_start: rows.get(bucketKey)!.windowStart }] };
});

vi.mock("@/db", () => ({ db: { execute: (q: { queryChunks: unknown[] }) => execute(q) } }));

/**
 * Auth is stubbed so the *ordering* can be observed: a test moves the
 * authentication outcome, and can then assert the limiter was never reached.
 */
type AuthOutcome =
  | { kind: "ok"; keyId: string }
  | { kind: "unauthorized" };
let auth: AuthOutcome = { kind: "ok", keyId: "a1b2c3d4e5f60718" };
let authCalls = 0;

vi.mock("@/lib/gateway/api-auth", () => ({
  requireApiKey: vi.fn(async () => {
    authCalls++;
    if (auth.kind === "unauthorized") {
      const { GatewayError } = await import("@/lib/gateway/errors");
      throw new GatewayError("GatewayError", "Invalid API key.", {
        category: "authentication_failure",
        status: 401,
      });
    }
    return { keyId: auth.keyId, userId: "usr_1", displayPrefix: "nexa_sk_test…" };
  }),
}));

const chat = vi.fn();
const listModels = vi.fn();
vi.mock("@/lib/gateway/gateway", () => ({
  NexaGateway: {
    chat: (...a: unknown[]) => chat(...a),
    listModels: () => listModels(),
  },
}));
vi.mock("@/lib/gateway/registry", () => ({
  GatewayModelRegistry: { toOpenAIModels: (m: unknown) => m },
}));

const { POST } = await import("@/app/v1/chat/completions/route");
const { GET: MODELS } = await import("@/app/v1/models/route");

const KEY_LIMIT = 2;

function chatRequest(ip = "203.0.113.7"): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer nexa_sk_test",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
  });
}

beforeEach(() => {
  rows.clear();
  storeError = null;
  execute.mockClear();
  authCalls = 0;
  auth = { kind: "ok", keyId: "a1b2c3d4e5f60718" };
  chat.mockResolvedValue({ id: "c1", content: "ok", model: "m", provider: "p" });
  listModels.mockResolvedValue([]);
  vi.stubEnv("NEXA_V1_KEY_RATE_LIMIT", String(KEY_LIMIT));
  vi.stubEnv("NEXA_V1_KEY_RATE_WINDOW_SECONDS", "60");
  vi.stubEnv("NEXA_V1_IP_RATE_LIMIT", "100");
  vi.stubEnv("NEXA_V1_IP_RATE_WINDOW_SECONDS", "60");
});

describe("authentication happens before rate limiting", () => {
  it("refuses an invalid key with 401 and never reaches the limiter", async () => {
    auth = { kind: "unauthorized" };
    const response = await POST(chatRequest());

    expect(response.status).toBe(401);
    // The store is never touched, so an unauthenticated request cannot consume
    // anyone's quota.
    expect(execute).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it("keeps refusing invalid keys with 401 even once a quota is exhausted", async () => {
    // Burn a real key's quota first.
    for (let i = 0; i < KEY_LIMIT; i++) await POST(chatRequest());
    // Only count store calls made from here on.
    execute.mockClear();

    // A bad key must still be an authentication failure, not a throttle.
    auth = { kind: "unauthorized" };
    const response = await POST(chatRequest());
    expect(response.status).toBe(401);
    // A revoked key is not told it is rate limited; that would hide a
    // credential problem behind an ordinary-looking throttle.
    expect(response.status).not.toBe(429);
    // …and it consumes no quota on its way out.
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not let an unauthenticated request advance a real key's counter", async () => {
    await POST(chatRequest());
    auth = { kind: "unauthorized" };
    await POST(chatRequest());
    auth = { kind: "ok", keyId: "a1b2c3d4e5f60718" };
    await POST(chatRequest());

    // Two authenticated requests, not three: the rejected one was never counted.
    // Both dimensions are at 2 — the address bucket is charged per admitted
    // request too, which is expected.
    expect([...rows.values()].map((r) => r.count)).toEqual([2, 2]);
  });
});

describe("per-key quota on chat", () => {
  it("serves requests within the limit and answers 429 beyond it", async () => {
    expect((await POST(chatRequest())).status).toBe(200);
    expect((await POST(chatRequest())).status).toBe(200);

    const limited = await POST(chatRequest());
    expect(limited.status).toBe(429);
    // The refused request must not have reached provider inference.
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("returns a standard error envelope with no internal detail", async () => {
    for (let i = 0; i < KEY_LIMIT; i++) await POST(chatRequest());
    const limited = await POST(chatRequest());
    const body = (await limited.json()) as {
      error: { message: string; type: string; code: string; nexa_category: string };
    };

    // Shape follows the gateway's existing error envelope (see
    // `toOpenAIError`), which is shared with every other error and already
    // asserted by gateway-v1-route.test.ts. It keeps the same required
    // members: message, type, code.
    expect(body.error.message).toMatch(/rate limit/i);
    expect(body.error.type).toBe("rate_limited");
    expect(body.error.code).toBe("RateLimited");
    expect(body.error.nexa_category).toBe("rate_limit");

    // No key, hash, bucket identity, SQL, or stack trace may appear.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("nexa_sk");
    expect(serialised).not.toMatch(/bucket_key|INSERT INTO|rate_limit_buckets/);
    expect(serialised).not.toContain("at Object");
  });

  it("reports Retry-After and the remaining quota", async () => {
    for (let i = 0; i < KEY_LIMIT; i++) await POST(chatRequest());
    const limited = await POST(chatRequest());

    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(limited.headers.get("x-ratelimit-limit")).toBe(String(KEY_LIMIT));
    expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
  });
});

describe("per-address quota on chat", () => {
  it("shares one address limit across different keys", async () => {
    vi.stubEnv("NEXA_V1_IP_RATE_LIMIT", "2");
    // A generous per-key limit, so only the address limit can bite.
    vi.stubEnv("NEXA_V1_KEY_RATE_LIMIT", "100");

    auth = { kind: "ok", keyId: "a1b2c3d4e5f60718" };
    expect((await POST(chatRequest("203.0.113.7"))).status).toBe(200);
    // A different key, same address.
    auth = { kind: "ok", keyId: "ffff000011112222" };
    expect((await POST(chatRequest("203.0.113.7"))).status).toBe(200);

    auth = { kind: "ok", keyId: "a1b2c3d4e5f60718" };
    const limited = await POST(chatRequest("203.0.113.7"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("x-ratelimit-limit")).toBe("2");
  });

  it("keeps different addresses independent", async () => {
    vi.stubEnv("NEXA_V1_IP_RATE_LIMIT", "1");
    vi.stubEnv("NEXA_V1_KEY_RATE_LIMIT", "100");

    expect((await POST(chatRequest("203.0.113.7"))).status).toBe(200);
    expect((await POST(chatRequest("203.0.113.7"))).status).toBe(429);
    // A different source address has its own allowance.
    expect((await POST(chatRequest("198.51.100.9"))).status).toBe(200);
  });
});

describe("store outage", () => {
  it("refuses chat rather than allowing unlimited upstream spend", async () => {
    storeError = new Error("connection terminated unexpectedly");
    const response = await POST(chatRequest());

    // Fail closed: a database outage must not become unlimited inference.
    expect(response.status).toBe(503);
    expect(chat).not.toHaveBeenCalled();
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("does not report an outage as a quota throttle", async () => {
    storeError = new Error("connection terminated unexpectedly");
    const response = await POST(chatRequest());
    // 503 keeps a monitoring system from filing this as ordinary throttling.
    expect(response.status).not.toBe(429);
    // A store failure advertises no quota, because there is no meaningful one.
    expect(response.headers.get("x-ratelimit-limit")).toBeNull();
  });

  it("leaks no database detail when the store is down", async () => {
    storeError = new Error("FATAL: password authentication failed for user nexa_admin");
    const serialised = await (await POST(chatRequest())).text();

    expect(serialised).not.toContain("nexa_admin");
    expect(serialised).not.toContain("password");
    expect(serialised).not.toContain("FATAL");
    expect(serialised).not.toContain("rate_limit_buckets");
  });

  it("still answers 401 for a bad key during an outage", async () => {
    storeError = new Error("store down");
    auth = { kind: "unauthorized" };
    // Auth is the first gate, so this stays an authentication failure.
    expect((await POST(chatRequest())).status).toBe(401);
  });
});

describe("read-only endpoints", () => {
  it("keeps model listing available when the limiter store is down", async () => {
    storeError = new Error("store down");
    const response = await MODELS(
      new Request("http://localhost/v1/models", { headers: { authorization: "Bearer nexa_sk_test" } })
    );
    // Fails open: a catalogue read should not break because of a counter.
    expect(response.status).toBe(200);
  });

  it("still limits model listing when the store is healthy", async () => {
    vi.stubEnv("NEXA_V1_MODELS_RATE_LIMIT", "1");
    const call = () =>
      MODELS(
        new Request("http://localhost/v1/models", { headers: { authorization: "Bearer nexa_sk_test" } })
      );
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
  });

  it("requires a key before consuming any quota", async () => {
    auth = { kind: "unauthorized" };
    const response = await MODELS(new Request("http://localhost/v1/models"));
    expect(response.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
});
