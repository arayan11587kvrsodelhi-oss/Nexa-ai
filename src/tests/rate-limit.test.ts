/**
 * Distributed rate limiting — deterministic behaviour.
 *
 * The PostgreSQL store is replaced by an in-memory double that reproduces the
 * *contract* of the real upsert (atomic increment, window rollover on a stale
 * bucket). What is asserted here is the limiter's decision logic — limits,
 * windows, dimensions, isolation, and the fail-open/fail-closed policy — not
 * PostgreSQL's own concurrency guarantees, which are verified for real in
 * `integration-rate-limit.mts` against a live database.
 *
 * The route-level ordering guarantees (auth before limit, so a bad key gets 401
 * and never spends a valid key's quota) are asserted in
 * `rate-limit-routes.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

/** Rows the fake store holds, mirroring the real table. */
interface Row {
  windowStart: number;
  count: number;
}

const rows = new Map<string, Row>();
let storeError: Error | null = null;
/** Awaits inserted between read and write, to expose read-then-write races. */
let storeLatencyTicks = 0;

/**
 * Faithful double for `INSERT … ON CONFLICT DO UPDATE … RETURNING`.
 *
 * `db.execute(query)` is called with the SQL object itself (not wrapped), and
 * for the pg driver it resolves to a `QueryResult` — the limiter reads
 * `result.rows`, and getting that shape wrong is a silent fail-open.
 */
const execute = vi.fn(async (query: { queryChunks: unknown[] }) => {
  // A chunk is either bound values (a raw scalar) or SQL text (an object whose
  // `value` is an array of strings). Taking everything that is not SQL text
  // yields the parameters in the order PostgreSQL would receive them:
  // bucketKey, then windowStart.
  const params = (query.queryChunks as unknown[]).filter(
    (chunk) => !(chunk !== null && typeof chunk === "object" && Array.isArray((chunk as { value?: unknown }).value))
  );
  const bucketKey = String(params[0]);
  const start = Number(params[1]);

  for (let i = 0; i < storeLatencyTicks; i++) await Promise.resolve();
  if (storeError) throw storeError;

  const existing = rows.get(bucketKey);
  const stale = !existing || existing.windowStart < start;
  const count = stale ? 1 : existing.count + 1;
  const windowStart = stale ? start : existing.windowStart;
  rows.set(bucketKey, { windowStart, count });
  return { rows: [{ count, window_start: windowStart }] };
});

vi.mock("@/db", () => ({
  db: { execute: (query: { queryChunks: unknown[] }) => execute(query) },
}));

const { consume, consumeAll, rateLimitConfig, windowStart } = await import(
  "@/lib/gateway/rate-limit"
);
const { clientAddress } = await import("@/lib/gateway/rate-limit-guard");

const policy = (over: Partial<Parameters<typeof consume>[1]> = {}) => ({
  dimension: "key" as const,
  limit: 3,
  windowSeconds: 60,
  failClosed: true,
  ...over,
});

beforeEach(() => {
  rows.clear();
  storeError = null;
  storeLatencyTicks = 0;
  execute.mockClear();
});

describe("per-key limiting", () => {
  it("allows requests within the limit and refuses the one beyond it", async () => {
    const p = policy({ limit: 3 });
    expect((await consume("v1:key:a", p)).allowed).toBe(true);
    expect((await consume("v1:key:a", p)).allowed).toBe(true);
    expect((await consume("v1:key:a", p)).allowed).toBe(true);

    const denied = await consume("v1:key:a", p);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it("resets the count once the window rolls over", async () => {
    const p = policy({ limit: 1, windowSeconds: 60 });
    const now = Date.now();

    expect((await consume("v1:key:a", p)).allowed).toBe(true);
    expect((await consume("v1:key:a", p)).allowed).toBe(false);
    expect((await consume("v1:key:a", p)).allowed).toBe(false);
    expect(rows.get("v1:key:a")?.windowStart).toBe(windowStart(now, 60));

    // Pretend the stored bucket belongs to a window that has already ended.
    // This is exactly the state a quiet key is in once its window passes.
    rows.set("v1:key:a", { windowStart: windowStart(now, 60) - 60_000, count: 99 });

    const afterRollover = await consume("v1:key:a", p);
    expect(afterRollover.allowed).toBe(true);
    expect(afterRollover.remaining).toBe(0);
    // The stale count is discarded, not carried forward.
    expect(rows.get("v1:key:a")?.count).toBe(1);
  });

  it("always reports a positive Retry-After", async () => {
    // The first call is the admitted one; the second is the refusal.
    await consume("v1:key:a", policy({ limit: 1 }));
    const denied = await consume("v1:key:a", policy({ limit: 1 }));
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    // Never more than the window itself, or a client would wait too long.
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
  });
});

describe("per-IP limiting", () => {
  it("shares one bucket across different keys from the same source", async () => {
    const ip = policy({ limit: 2, dimension: "ip" });
    // Different keys, same address: the per-IP bucket is what binds them.
    expect((await consume("v1:ip:203.0.113.7", ip)).allowed).toBe(true);
    expect((await consume("v1:ip:203.0.113.7", ip)).allowed).toBe(true);
    expect((await consume("v1:ip:203.0.113.7", ip)).allowed).toBe(false);
  });
});

describe("isolation", () => {
  it("keeps different keys independent", async () => {
    const p = policy({ limit: 1 });
    expect((await consume("v1:key:a", p)).allowed).toBe(true);
    expect((await consume("v1:key:a", p)).allowed).toBe(false);
    // Exhausting one key must not affect another.
    expect((await consume("v1:key:b", p)).allowed).toBe(true);
    expect((await consume("v1:key:b", p)).allowed).toBe(false);
  });

  it("keeps different addresses independent", async () => {
    const p = policy({ limit: 1, dimension: "ip" });
    expect((await consume("v1:ip:203.0.113.7", p)).allowed).toBe(true);
    expect((await consume("v1:ip:203.0.113.7", p)).allowed).toBe(false);
    expect((await consume("v1:ip:198.51.100.9", p)).allowed).toBe(true);
  });

  it("keeps the key and address dimensions independent of one another", async () => {
    // Identical numbers in both dimensions, so only dimension identity can
    // explain the outcome.
    const p = policy({ limit: 1 });
    expect((await consume("v1:key:a", p)).allowed).toBe(true);
    expect((await consume("v1:ip:203.0.113.7", p)).allowed).toBe(true);
    expect((await consume("v1:key:a", p)).allowed).toBe(false);
    expect((await consume("v1:ip:203.0.113.7", p)).allowed).toBe(false);
  });
});

describe("combining dimensions", () => {
  it("refuses when either dimension is exhausted and charges both", async () => {
    // Per-key is the tighter limit here, so it is the one that refuses.
    expect(
      (
        await consumeAll([
          { bucketKey: "v1:key:a", policy: policy({ limit: 1 }) },
          { bucketKey: "v1:ip:203.0.113.7", policy: policy({ limit: 5 }) },
        ])
      ).allowed
    ).toBe(true);

    const second = await consumeAll([
      { bucketKey: "v1:key:a", policy: policy({ limit: 1 }) },
      { bucketKey: "v1:ip:203.0.113.7", policy: policy({ limit: 5 }) },
    ]);
    expect(second.allowed).toBe(false);
    expect(second.limit).toBe(1);

    // Both buckets were charged: one user request, one unit per dimension.
    expect(rows.get("v1:key:a")?.count).toBe(2);
    expect(rows.get("v1:ip:203.0.113.7")?.count).toBe(2);
  });

  it("refuses on the address even when the key still has quota", async () => {
    expect(
      (
        await consumeAll([
          { bucketKey: "v1:key:a", policy: policy({ limit: 10 }) },
          { bucketKey: "v1:ip:203.0.113.7", policy: policy({ limit: 1 }) },
        ])
      ).allowed
    ).toBe(true);

    // A *different* key from the same address: its own quota is untouched, but
    // the shared address limit still applies.
    const second = await consumeAll([
      { bucketKey: "v1:key:b", policy: policy({ limit: 10 }) },
      { bucketKey: "v1:ip:203.0.113.7", policy: policy({ limit: 1 }) },
    ]);
    expect(second.allowed).toBe(false);
    expect(second.limit).toBe(1);
  });

  it("charges a user request once per dimension, not once per retry", async () => {
    // One request → one upsert per dimension. Provider retries happen further
    // in and must not add charges here.
    await consumeAll([
      { bucketKey: "v1:key:a", policy: policy() },
      { bucketKey: "v1:ip:203.0.113.7", policy: policy() },
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect([...rows.values()].map((r) => r.count)).toEqual([1, 1]);
  });
});

describe("store failure policy", () => {
  it("fails closed where the cost is real, and says so", async () => {
    storeError = new Error("connection terminated unexpectedly");
    const decision = await consume("v1:key:a", policy({ failClosed: true }));

    expect(decision.allowed).toBe(false);
    expect(decision.storeUnavailable).toBe(true);
    // Distinguishable from an exhausted quota, so the route can answer 503.
    expect(decision.deniedByStoreFailure).toBe(true);
  });

  it("fails open where availability matters more", async () => {
    storeError = new Error("connection terminated unexpectedly");
    const decision = await consume("v1:key:a", policy({ failClosed: false }));

    expect(decision.allowed).toBe(true);
    expect(decision.storeUnavailable).toBe(true);
    // Failing open is not an exceeded quota, so nothing reports it as one.
    expect(decision.deniedByStoreFailure).toBe(false);
  });

  it("does not leak the database error to the caller", async () => {
    storeError = new Error("FATAL: password authentication failed for user nexa_admin");
    const decision = await consume("v1:key:a", policy());

    expect(decision.allowed).toBe(false);
    const serialised = JSON.stringify(decision);
    expect(serialised).not.toContain("password");
    expect(serialised).not.toContain("nexa_admin");
    expect(serialised).not.toContain("FATAL");
  });

  it("recovers once the store returns", async () => {
    storeError = new Error("temporary blip");
    expect((await consume("v1:key:a", policy())).allowed).toBe(false);

    storeError = null;
    expect((await consume("v1:key:a", policy())).allowed).toBe(true);
  });
});

describe("concurrency", () => {
  it("does not admit substantially more than the limit under parallel load", async () => {
    // The store double is given a chance to interleave; a read-then-write limiter
    // would over-admit here. The single-statement upsert cannot.
    storeLatencyTicks = 2;
    const p = policy({ limit: 10 });

    const decisions = await Promise.all(
      Array.from({ length: 50 }, () => consume("v1:key:a", p))
    );
    const allowed = decisions.filter((d) => d.allowed).length;

    // Exactly the limit. A read-then-write implementation would report 50.
    expect(allowed).toBe(10);
    expect(rows.get("v1:key:a")?.count).toBe(50);
  });

  it("counts every concurrent request, not just the admitted ones", async () => {
    storeLatencyTicks = 2;
    await Promise.all(
      Array.from({ length: 20 }, () => consume("v1:key:a", policy({ limit: 5 })))
    );
    // Refused requests still consume quota, so a flood cannot reset the window.
    expect(rows.get("v1:key:a")?.count).toBe(20);
  });

  it("keeps concurrent per-dimension charges separate", async () => {
    storeLatencyTicks = 2;
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => consume(`v1:key:k${i % 3}`, policy({ limit: 100 })))
    );
    expect(rows.get("v1:key:k0")?.count).toBe(10);
    expect(rows.get("v1:key:k1")?.count).toBe(10);
    expect(rows.get("v1:key:k2")?.count).toBe(10);
  });
});

describe("configuration", () => {
  it("reads limits from the environment, not from route code", async () => {
    vi.stubEnv("NEXA_V1_KEY_RATE_LIMIT", "7");
    vi.stubEnv("NEXA_V1_KEY_RATE_WINDOW_SECONDS", "30");
    vi.stubEnv("NEXA_V1_IP_RATE_LIMIT", "11");
    const config = rateLimitConfig();

    expect(config.chat.key.limit).toBe(7);
    expect(config.chat.key.windowSeconds).toBe(30);
    expect(config.chat.ip.limit).toBe(11);
    vi.unstubAllEnvs();
  });

  it("falls back to documented defaults when unset", () => {
    const config = rateLimitConfig();
    expect(config.chat.key).toEqual({
      dimension: "key",
      limit: 60,
      windowSeconds: 60,
      failClosed: true,
    });
    expect(config.chat.ip).toEqual({
      dimension: "ip",
      limit: 120,
      windowSeconds: 60,
      failClosed: true,
    });
    // Read-only endpoints stay available while the store is down.
    expect(config.models.failClosed).toBe(false);
    expect(config.health.failClosed).toBe(false);
  });

  it("clamps nonsense configuration instead of trusting it", () => {
    vi.stubEnv("NEXA_V1_KEY_RATE_LIMIT", "0");
    vi.stubEnv("NEXA_V1_KEY_RATE_WINDOW_SECONDS", "-5");
    const config = rateLimitConfig();
    // A zero or negative limit would deny every request; clamping keeps the
    // endpoint usable rather than bricking it by typo.
    expect(config.chat.key.limit).toBeGreaterThanOrEqual(1);
    expect(config.chat.key.windowSeconds).toBeGreaterThanOrEqual(1);
    vi.unstubAllEnvs();
  });

  it("ignores a non-numeric limit rather than propagating NaN", () => {
    vi.stubEnv("NEXA_V1_KEY_RATE_LIMIT", "lots");
    expect(rateLimitConfig().chat.key.limit).toBe(60);
    vi.unstubAllEnvs();
  });

  it("aligns windows to a fixed grid so concurrent callers share one bucket", () => {
    // Fixed, not per-request-anchored: two callers seconds apart must land in
    // the same window, or each would get a fresh quota.
    // 1_700_000_045_000 and _048_000 are both 45s/48s into the window that
    // began at 1_700_000_040_000; _100_000 is in the next one.
    expect(windowStart(1_700_000_045_000, 60) % 60_000).toBe(0);
    expect(windowStart(1_700_000_045_000, 60)).toBe(windowStart(1_700_000_048_000, 60));
    expect(windowStart(1_700_000_045_000, 60)).not.toBe(windowStart(1_700_000_100_000, 60));
  });
});

describe("client address resolution", () => {
  it("prefers the platform's own header", () => {
    const headers = new Headers({
      "x-vercel-forwarded-for": "203.0.113.7",
      "x-forwarded-for": "198.51.100.1",
    });
    expect(clientAddress(headers)).toBe("203.0.113.7");
  });

  it("takes the first hop of a forwarding chain", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7, 198.51.100.1, 10.0.0.1" });
    expect(clientAddress(headers)).toBe("203.0.113.7");
  });

  it("accepts IPv6", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
  });

  it("groups requests with no usable address together", () => {
    // A single shared bucket is the safe default: a caller that strips the
    // headers throttles only itself, not a real user's quota.
    expect(clientAddress(new Headers())).toBe("unknown");
  });

  it("ignores a value that is not an address rather than trusting it", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "not an address at all" }))).toBe(
      "unknown"
    );
  });

  it("truncates an oversized header so it cannot bloat a primary key", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "a".repeat(5_000) }))).toHaveLength(64);
  });
});
