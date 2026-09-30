/**
 * API key management — route contract and security.
 *
 * The store is stubbed so the *route* contract can be asserted precisely (who is
 * authenticated, what is scoped, what is never returned). The real PostgreSQL
 * behaviour of the service — digest-only storage, one-time plaintext,
 * revocation — is asserted separately in `integration-api-keys.mts` against the
 * live database.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const OWNER = "usr_owner";
const OTHER = "usr_other";
/** Real key ids are 16 hex characters; fixtures must match the route validator. */
const KEY_ID = "a1b2c3d4e5f60718";

const list = vi.fn();
const create = vi.fn();
const revoke = vi.fn();

vi.mock("@/lib/gateway/api-key-store", () => ({
  ApiKeyService: { list, create, revoke },
}));

// The session decides the user. A test can move that cookie, nothing else.
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

/**
 * The rate-limit store.
 *
 * The creation quota is enforced here, so a bucket counter is needed. It is
 * keyed exactly as production keys it, so the tests below assert real bucket
 * isolation rather than a mock's behaviour.
 */
interface RateLimitRow {
  windowStart: number;
  count: number;
}
const rateLimitRows = new Map<string, RateLimitRow>();

vi.mock("@/db", () => ({
  db: {
    execute: vi.fn(async (query: { queryChunks: unknown[] }) => {
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
      const existing = rateLimitRows.get(bucketKey);
      const stale = !existing || existing.windowStart < start;
      const count = stale ? 1 : existing.count + 1;
      const windowStart = stale ? start : existing.windowStart;
      rateLimitRows.set(bucketKey, { windowStart, count });
      return { rows: [{ count, window_start: windowStart }] };
    }),
  },
}));

const { GET, POST } = await import("@/app/api/api-keys/route");
const { DELETE } = await import("@/app/api/api-keys/[id]/route");

/**
 * Key-creation quota, the same guard the route calls.
 *
 * Exposed here so a test can consume a user's quota directly and then observe
 * the route's refusal.
 */
const { checkApiKeyCreationLimit } = await import("@/lib/gateway/rate-limit-guard");

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/api-keys", {
    method,
    headers: {
      "content-type": "application/json",
      // A client-supplied identity must be ignored entirely.
      "x-nexa-user-id": OTHER,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as NextRequest;
}

function summary(over: Record<string, unknown> = {}) {
  return {
    id: KEY_ID,
    name: "My local NEXA integration",
    keyPrefix: "nexa_sk_a1b2c3…",
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    requestCount: 0,
    ...over,
  };
}

beforeEach(() => {
  list.mockReset();
  create.mockReset();
  revoke.mockReset();
  rateLimitRows.clear();
  sessionUser = OWNER;
  vi.stubEnv("NEXA_API_KEY_CREATE_RATE_LIMIT", "3");
  vi.stubEnv("NEXA_API_KEY_CREATE_RATE_WINDOW_SECONDS", "3600");
  list.mockResolvedValue([]);
  create.mockResolvedValue({
    plaintext: "nexa_sk_plaintext_value_that_must_not_persist",
    summary: summary(),
  });
  revoke.mockResolvedValue(true);
});

describe("authentication", () => {
  it("rejects an unauthenticated list with 401", async () => {
    sessionUser = null;
    const res = await GET(req("GET"));
    expect(res.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated create with 401", async () => {
    sessionUser = null;
    const res = await POST(req("POST", { name: "x" }));
    expect(res.status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("ownership", () => {
  it("scopes the list to the session user and ignores client-supplied ids", async () => {
    list.mockResolvedValue([summary()]);
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith(OWNER);
  });

  it("scopes creation to the session user", async () => {
    await POST(req("POST", { name: "My local NEXA integration" }));
    expect(create).toHaveBeenCalledWith(
      OWNER,
      "My local NEXA integration",
      expect.anything()
    );
  });

  it("scopes revocation, so User A cannot revoke User B's key", async () => {
    const params = Promise.resolve({ id: KEY_ID });
    const res = await DELETE(req("DELETE"), { params });
    expect(res.status).toBe(200);
    expect(revoke).toHaveBeenCalledWith(OWNER, KEY_ID);
  });

  it("reports 404 when the key is not owned by the session user", async () => {
    revoke.mockResolvedValue(false);
    const params = Promise.resolve({ id: "ccccccccccccccc3" });
    const res = await DELETE(req("DELETE"), { params });
    // 404, not 403: the response must not confirm another user's key exists.
    expect(res.status).toBe(404);
  });
});

describe("creation response", () => {
  it("returns the plaintext exactly once, with no-store", async () => {
    const res = await POST(req("POST", { name: "My local NEXA integration" }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { plaintext: string; key: Record<string, unknown> };
    expect(body.plaintext).toBe("nexa_sk_plaintext_value_that_must_not_persist");
    expect(body.key.id).toBe(KEY_ID);
  });

  it("never includes the digest, the pepper, or a request count", async () => {
    const res = await POST(req("POST", { name: "x" }));
    const serialized = await res.text();
    expect(serialized).not.toMatch(/keyHash|key_hash|pepper|requestCount/);
  });

  it("does not return the plaintext on a subsequent list", async () => {
    list.mockResolvedValue([summary()]);
    const res = await GET(req("GET"));
    const serialized = await res.text();
    expect(serialized).not.toContain("nexa_sk_plaintext");
    expect(serialized).not.toMatch(/keyHash|pepper/);
  });

  it("returns only the display prefix, never a full key, in the list", async () => {
    list.mockResolvedValue([summary()]);
    const res = await GET(req("GET"));
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys[0].keyPrefix).toBe("nexa_sk_a1b2c3…");
    // No string in the payload looks like a usable key.
    expect(JSON.stringify(body)).not.toMatch(/nexa_sk_[A-Za-z0-9_-]{20,}/);
  });
});

describe("status reporting", () => {
  it("marks an unused key as active and invents no last-used value", async () => {
    list.mockResolvedValue([summary({ lastUsedAt: null })]);
    const res = await GET(req("GET"));
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys[0].status).toBe("active");
    expect(body.keys[0].lastUsedAt).toBeNull();
  });

  it("distinguishes revoked from active", async () => {
    list.mockResolvedValue([
      summary({ id: "aaaaaaaaaaaaaaa1", revokedAt: new Date().toISOString() }),
      summary({ id: "bbbbbbbbbbbbbbb2", revokedAt: null }),
    ]);
    const res = await GET(req("GET"));
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys.find((k) => k.id === "aaaaaaaaaaaaaaa1")?.status).toBe("revoked");
    expect(body.keys.find((k) => k.id === "bbbbbbbbbbbbbbb2")?.status).toBe("active");
  });

  it("marks an elapsed expiry as expired rather than active", async () => {
    list.mockResolvedValue([summary({ expiresAt: new Date(Date.now() - 1000).toISOString() })]);
    const res = await GET(req("GET"));
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys[0].status).toBe("expired");
  });
});

describe("input validation", () => {
  it("rejects an empty name", async () => {
    const res = await POST(req("POST", { name: "   " }));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an excessively long name", async () => {
    const res = await POST(req("POST", { name: "x".repeat(500) }));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a body that is not an object", async () => {
    const res = await POST(req("POST", "just a string"));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an implausible expiry", async () => {
    const res = await POST(req("POST", { name: "ok", expiresInDays: 99_999 }));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a malformed key id on revoke", async () => {
    const params = Promise.resolve({ id: "../../etc/passwd" });
    const res = await DELETE(req("DELETE"), { params });
    expect(res.status).toBe(400);
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("key creation quota", () => {
  it("allows creation within the limit", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await POST(req("POST", { name: `key ${i}` }));
      expect(res.status).toBe(201);
    }
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("refuses creation beyond the limit with 429 and Retry-After", async () => {
    for (let i = 0; i < 3; i++) await POST(req("POST", { name: `key ${i}` }));

    const res = await POST(req("POST", { name: "one too many" }));
    expect(res.status).toBe(429);
    // The refused request must not have created anything.
    expect(create).toHaveBeenCalledTimes(3);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("reports the quota in a standard envelope with no internal detail", async () => {
    for (let i = 0; i < 3; i++) await POST(req("POST", { name: `key ${i}` }));
    const res = await POST(req("POST", { name: "one too many" }));
    const body = (await res.json()) as { error: string; code: string };

    expect(body.code).toBe("RATE_LIMITED");
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("nexa_sk");
    expect(serialised).not.toMatch(/bucket_key|rate_limit_buckets|INSERT INTO/);
  });

  it("enforces the quota per user, not globally", async () => {
    for (let i = 0; i < 3; i++) await POST(req("POST", { name: `key ${i}` }));
    expect((await POST(req("POST", { name: "blocked" }))).status).toBe(429);

    // A different account must not inherit the first one's exhausted quota.
    sessionUser = OTHER;
    const res = await POST(req("POST", { name: "other user's key" }));
    expect(res.status).toBe(201);
  });

  it("ignores a client-supplied user id when bucketing", async () => {
    for (let i = 0; i < 3; i++) await POST(req("POST", { name: `key ${i}` }));
    // `req()` always sets `x-nexa-user-id: OTHER`; it must not move the caller
    // into that account's (empty) bucket.
    const res = await POST(req("POST", { name: "spoof attempt" }));
    expect(res.status).toBe(429);
  });

  it("never charges the quota to an unauthenticated caller", async () => {
    sessionUser = null;
    const res = await POST(req("POST", { name: "no session" }));
    expect(res.status).toBe(401);
    // Authentication is the first gate, so no bucket was touched.
    expect(rateLimitRows.size).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps refusing after the window expires rather than staying blocked", async () => {
    for (let i = 0; i < 3; i++) await POST(req("POST", { name: `key ${i}` }));
    expect((await POST(req("POST", { name: "blocked" }))).status).toBe(429);

    // Backdate the bucket, exactly as the hour passing would.
    for (const row of rateLimitRows.values()) row.windowStart -= 3_600_000;

    const res = await POST(req("POST", { name: "after the window" }));
    expect(res.status).toBe(201);
  });

  it("does not consume quota for reads, so browsing is never throttled", async () => {
    for (let i = 0; i < 5; i++) await POST(req("POST", { name: `key ${i}` }));
    expect((await POST(req("POST", { name: "blocked" }))).status).toBe(429);

    // Listing keys is a read; it must stay available for the user to manage
    // and revoke what they already have.
    expect((await GET(req("GET"))).status).toBe(200);
  });

  it("exposes the same decision the route enforces", async () => {
    // Guards against the route and the test disagreeing about the bucket key.
    for (let i = 0; i < 3; i++) await checkApiKeyCreationLimit(OWNER);
    expect((await POST(req("POST", { name: "blocked" }))).status).toBe(429);
  });
});

