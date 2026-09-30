/**
 * NEXA AI Gateway — distributed rate limiting (PostgreSQL).
 *
 * Why PostgreSQL and not an in-process `Map`: NEXA runs on serverless
 * infrastructure where each instance has its own memory. A `Map` would enforce
 * a *per-instance* quota, so the real limit would scale with the instance
 * count — the exact illusion of protection that must not be shipped.
 * PostgreSQL is already a hard production dependency and is shared by every
 * instance. (No Redis/KV client is installed, and adding one for a counter a
 * transaction can do would be unjustified complexity.)
 *
 * These are **abuse and quota controls**, not a security guarantee. They bound
 * how fast one key or one source can spend an upstream provider's quota. They do
 * not stop a determined attacker spreading across keys or addresses.
 *
 * Correctness under concurrency: the increment and the window rollover happen in
 * a single `INSERT … ON CONFLICT DO UPDATE … RETURNING`. Two concurrent requests
 * cannot both read `count = 5` and both write `count = 6`; one sees the other's
 * write. A read-then-write limiter over-admits under load.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { envInt } from "./config";

/** Which dimension a request is counted against. */
export type RateLimitDimension = "key" | "ip";

export interface RateLimitPolicy {
  dimension: RateLimitDimension;
  /** Requests allowed per window. */
  limit: number;
  windowSeconds: number;
  /**
   * What to do when the store itself is unreachable.
   *
   * `true`  — fail closed: deny the request.
   * `false` — fail open: allow the request.
   */
  failClosed: boolean;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the current window resets. Reliable only when known. */
  retryAfterSeconds: number;
  limit: number;
  remaining: number;
  /** True when the limiter could not reach the store at all. */
  storeUnavailable: boolean;
  /**
   * True when this specific denial is *because* the store was unreachable, not
   * because a quota was exceeded. The two must not share a response: a broken
   * limiter is an outage (503), an exhausted quota is a throttle (429). Reporting
   * an outage as 429 would tell every client to stop retrying and would hide a
   * real incident behind an ordinary-looking throttle.
   */
  deniedByStoreFailure: boolean;
}

/**
 * Configuration. Limits are operator controls, never hardcoded constants inside
 * a route, so a deployment can tighten them without a code change.
 */
export function rateLimitConfig(): {
  chat: { key: RateLimitPolicy; ip: RateLimitPolicy };
  chatSession: { user: RateLimitPolicy; ip: RateLimitPolicy };
  agent: { user: RateLimitPolicy; ip: RateLimitPolicy };
  fileUpload: { user: RateLimitPolicy; ip: RateLimitPolicy };
  models: RateLimitPolicy;
  health: RateLimitPolicy;
  apiKeyCreate: RateLimitPolicy;
  tools: RateLimitPolicy;
  search: RateLimitPolicy;
} {
  return {
    chat: {
      // Protects upstream spend, so both dimensions are strict and fail closed.
      key: {
        dimension: "key",
        limit: envInt("NEXA_V1_KEY_RATE_LIMIT", 60, 1, 100_000),
        windowSeconds: envInt("NEXA_V1_KEY_RATE_WINDOW_SECONDS", 60, 1, 86_400),
        failClosed: true,
      },
      ip: {
        dimension: "ip",
        limit: envInt("NEXA_V1_IP_RATE_LIMIT", 120, 1, 100_000),
        windowSeconds: envInt("NEXA_V1_IP_RATE_WINDOW_SECONDS", 60, 1, 86_400),
        failClosed: true,
      },
    },
    // Read-only catalogue: cheap for NEXA, so a lighter per-key limit. Discovery
    // answers from cache and hits providers, so failing open keeps a database
    // blip from breaking model listing.
    models: {
      dimension: "key",
      limit: envInt("NEXA_V1_MODELS_RATE_LIMIT", 60, 1, 100_000),
      windowSeconds: envInt("NEXA_V1_MODELS_RATE_WINDOW_SECONDS", 60, 1, 86_400),
      failClosed: false,
    },
    // Liveness probe: must not be blocked, or a monitor would report a false
    // outage. Shaped only enough to stop a trivial flood.
    health: {
      dimension: "key",
      limit: envInt("NEXA_V1_HEALTH_RATE_LIMIT", 60, 1, 100_000),
      windowSeconds: envInt("NEXA_V1_HEALTH_RATE_WINDOW_SECONDS", 60, 1, 86_400),
      failClosed: false,
    },
    // API-key creation from the signed-in settings UI. Keyed by the resolved
    // user id, so it bounds how many keys one account can mint. Fail-closed is
    // free here: creating a key is itself a database write, so a dead store
    // would fail the request regardless.
    apiKeyCreate: {
      dimension: "key",
      limit: envInt("NEXA_API_KEY_CREATE_RATE_LIMIT", 10, 1, 10_000),
      windowSeconds: envInt("NEXA_API_KEY_CREATE_RATE_WINDOW_SECONDS", 3600, 1, 86_400),
      failClosed: true,
    },
    // ---------------------------------------------------------------------
    // POST /api/chat — the session-authenticated chat route.
    //
    // Deliberately NOT the same numbers as `chat` above. Those were chosen for
    // *machine* clients holding an API key; this principal is a signed-in human
    // in an interactive UI, where one request is one visible message.
    //
    // The IP limit is exactly 2x the user limit, the same ratio Phase 5 uses
    // for /v1 (60 key / 120 ip), so a shared NAT (household, office, mobile
    // carrier) is not throttled by its other members.
    // ---------------------------------------------------------------------
    chatSession: {
      user: {
        // Interactive chat cannot plausibly exceed this: the client sends one
        // request per submitted message, and a human cannot sustain 30
        // messages a minute. Halving Phase 5's 60/min therefore removes real
        // headroom while halving the worst-case cost of a stolen session — and
        // 30 upstream inferences a minute is still far above any legitimate
        // burst.
        dimension: "key",
        limit: envInt("NEXA_CHAT_USER_RATE_LIMIT", 30, 1, 100_000),
        windowSeconds: envInt("NEXA_CHAT_USER_RATE_WINDOW_SECONDS", 60, 1, 86_400),
        // Fail closed. This is the single most expensive endpoint in the app:
        // one request runs a real inference chain (bounded at 2 attempts per
        // candidate, 6 total). An unreachable limiter store must never become
        // unlimited inference, so this route refuses rather than guessing.
        failClosed: true,
      },
      ip: {
        dimension: "ip",
        limit: envInt("NEXA_CHAT_IP_RATE_LIMIT", 60, 1, 100_000),
        windowSeconds: envInt("NEXA_CHAT_IP_RATE_WINDOW_SECONDS", 60, 1, 86_400),
        failClosed: true,
      },
    },
    // ---------------------------------------------------------------------
    // POST /api/agents — agent runs.
    //
    // Added in Phase 5.3 after verifying that this route reaches the SAME tool
    // implementations `/api/tools` and `/api/search` limit (web_search spends
    // metered search quota; file_search runs an unindexed full table scan), but
    // does so by calling `ToolExecutor.execute` directly. A limiter on those two
    // HTTP routes cannot observe an agent-originated tool call.
    // ---------------------------------------------------------------------
    agent: {
      user: {
        // An agent run is heavier than a chat message: it writes an
        // `agent_runs` row, performs a database query, and may call a metered
        // external provider. But it is also a deliberate, occasional action —
        // a person typing a goal — not a conversational turn. 20/min leaves
        // ample room for real use while capping the blast radius of a scripted
        // loop that fires the route repeatedly.
        dimension: "key",
        limit: envInt("NEXA_AGENT_USER_RATE_LIMIT", 20, 1, 100_000),
        windowSeconds: envInt("NEXA_AGENT_USER_RATE_WINDOW_SECONDS", 60, 1, 86_400),
        // Fail closed. The route already requires the database (`requireUser`),
        // so a limiter-store outage means the request was failing anyway;
        // denying costs no availability and avoids an unbounded tool path.
        failClosed: true,
      },
      ip: {
        // 3x the user limit: one address can legitimately cover several
        // accounts behind a shared NAT, and agent runs are rarer than chat
        // messages, so a looser address budget does not conflict with the
        // per-user bound, which is the tighter constraint here.
        dimension: "ip",
        limit: envInt("NEXA_AGENT_IP_RATE_LIMIT", 60, 1, 100_000),
        windowSeconds: envInt("NEXA_AGENT_IP_RATE_WINDOW_SECONDS", 60, 1, 86_400),
        failClosed: true,
      },
    },
    // ---------------------------------------------------------------------
    // POST /api/files — document upload + indexing.
    //
    // Phase 5.4. Verified: this route had no application-level limit at all.
    // It is not a cheap write. One accepted upload performs, in sequence:
    // a 20 MB body read, text extraction, a document insert carrying the whole
    // raw text, chunking at 650 chars, a `generateEmbedding` call *per chunk*,
    // and batched chunk inserts. On a ~1 MB document that is roughly 1,500
    // embedding computations plus multiple round trips. Repeated uploads are
    // therefore both a CPU/IO amplifier and unbounded storage growth.
    // ---------------------------------------------------------------------
    fileUpload: {
      user: {
        // Uploading is a deliberate, occasional human action, not a
        // conversational turn. 10/min leaves room for a bulk import while
        // capping the blast radius of a script looping this endpoint.
        dimension: "key",
        limit: envInt("NEXA_FILE_UPLOAD_USER_RATE_LIMIT", 10, 1, 100_000),
        windowSeconds: envInt("NEXA_FILE_UPLOAD_USER_RATE_WINDOW_SECONDS", 60, 1, 86_400),
        // Fail closed. The route is already database-bound (`requireUser` plus
        // several writes), so a limiter-store outage means the request was
        // failing regardless; denying costs no availability.
        failClosed: true,
      },
      ip: {
        // 2x the user limit, matching the chat and tools ratios, so a shared
        // NAT serving several accounts is not throttled by its other members.
        dimension: "ip",
        limit: envInt("NEXA_FILE_UPLOAD_IP_RATE_LIMIT", 20, 1, 100_000),
        windowSeconds: envInt("NEXA_FILE_UPLOAD_IP_RATE_WINDOW_SECONDS", 60, 1, 86_400),
        failClosed: true,
      },
    },
    // ---------------------------------------------------------------------
    // Session-scoped limits for the two session-authenticated routes that can
    // reach a *metered third-party* API. See the Phase 5.1 audit in
    // docs/ENVIRONMENT.md for why these two specifically, and why the other
    // `/api/*` routes are deliberately left unlimited.
    // ---------------------------------------------------------------------

    // POST /api/tools. Most tools are cheap local CPU, but two are not:
    // `web_search` spends metered search quota, and `file_search` runs an
    // unindexed `ilike` over `documents.rawContent` — a full scan per call.
    // Set well above interactive use (one chat turn may legitimately fire
    // several tool calls) but low enough that a runaway loop stays bounded.
    tools: {
      dimension: "key",
      limit: envInt("NEXA_TOOLS_RATE_LIMIT", 60, 1, 100_000),
      windowSeconds: envInt("NEXA_TOOLS_RATE_WINDOW_SECONDS", 60, 1, 86_400),
      // Free to fail closed: this route already requires the database
      // (`requireUser`), so a limiter-store outage means the route is dead
      // regardless. Denying costs no availability.
      failClosed: true,
    },

    // POST /api/search. Every call spends a metered Tavily/Brave credential or
    // a SearXNG round trip, so the bound is tighter than tools. The caller-
    // supplied `limit` parameter is the amplification knob that makes an
    // unbounded loop expensive, which is why this route needs a bound at all.
    search: {
      dimension: "key",
      limit: envInt("NEXA_SEARCH_RATE_LIMIT", 30, 1, 100_000),
      windowSeconds: envInt("NEXA_SEARCH_RATE_WINDOW_SECONDS", 60, 1, 86_400),
      // Same reasoning as tools: already database-dependent, so free to deny.
      failClosed: true,
    },
  };
}

/** Start of the fixed window containing `now`, for a window of `windowSeconds`. */
export function windowStart(now: number, windowSeconds: number): number {
  const width = windowSeconds * 1000;
  return Math.floor(now / width) * width;
}

/**
 * Consume one unit from a bucket and report the resulting decision.
 *
 * A single statement, so concurrent callers are serialised by the row lock.
 */
export async function consume(
  bucketKey: string,
  policy: RateLimitPolicy
): Promise<RateLimitDecision> {
  const now = Date.now();
  const start = windowStart(now, policy.windowSeconds);

  try {
    // NOTE: for the node-postgres driver `db.execute()` resolves to the `pg`
    // QueryResult ({ rows, rowCount, ... }) — NOT a bare array. Reading
    // `result[0]` here would yield undefined, and the `?? 1` fallback below
    // would then let every request through: a silent fail-open. `rows` is read
    // explicitly, and an unexpected shape throws into the catch below (which
    // still applies fail-closed) rather than admitting the request.
    const result = (await db.execute(sql`
      INSERT INTO rate_limit_buckets (bucket_key, window_start, count, updated_at)
      VALUES (${bucketKey}, ${start}, 1, now())
      ON CONFLICT (bucket_key) DO UPDATE SET
        count = CASE
          WHEN rate_limit_buckets.window_start < ${start} THEN 1
          ELSE rate_limit_buckets.count + 1
        END,
        window_start = CASE
          WHEN rate_limit_buckets.window_start < ${start} THEN ${start}
          ELSE rate_limit_buckets.window_start
        END,
        updated_at = now()
      RETURNING count, window_start
    `)) as unknown as { rows?: Array<{ count: number; window_start: number }> };

    const row = result.rows?.[0];
    if (!row) throw new Error("Rate-limit upsert returned no row.");
    const count = Number(row.count);
    // The window this row actually belongs to, which may still be the previous
    // one if another request wrote it just before the boundary.
    const resetAt = Number(row.window_start) + policy.windowSeconds * 1000;

    return {
      allowed: count <= policy.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - count),
      storeUnavailable: false,
      deniedByStoreFailure: false,
    };
  } catch (error) {
    // The caller decides, via policy.failClosed, whether an unreachable limiter
    // is an outage (deny) or a nuisance (allow). The reason is logged server-side
    // only; the client never sees a database error.
    console.warn("[nexa] rate-limit store unavailable:", error);
    return {
      allowed: !policy.failClosed,
      retryAfterSeconds: 1,
      limit: policy.limit,
      remaining: 0,
      storeUnavailable: true,
      // Only a fail-closed policy actually refuses the request, and when it does
      // the refusal is the outage, not an exceeded quota.
      deniedByStoreFailure: policy.failClosed,
    };
  }
}

/**
 * Apply several policies and return the most restrictive outcome.
 *
 * Every policy is consumed, so a request rejected by the per-IP limit has
 * already been counted against the per-key bucket. One user request therefore
 * always costs exactly one unit — never one per policy, and never one per
 * provider retry or fallback the gateway performs internally.
 */
export async function consumeAll(
  buckets: Array<{ bucketKey: string; policy: RateLimitPolicy }>
): Promise<RateLimitDecision> {
  const decisions: RateLimitDecision[] = [];
  for (const { bucketKey, policy } of buckets) {
    decisions.push(await consume(bucketKey, policy));
  }

  const denied = decisions.filter((d) => !d.allowed);
  if (denied.length > 0) {
    // The tightest constraint wins, so the caller waits the longest.
    return {
      ...denied.reduce((worst, d) => (d.retryAfterSeconds > worst.retryAfterSeconds ? d : worst)),
      allowed: false,
    };
  }
  return {
    ...decisions.reduce((tightest, d) => (d.limit < tightest.limit ? d : tightest)),
    allowed: true,
  };
}

/**
 * Remove buckets nobody has touched recently.
 *
 * Called opportunistically. Expiry is not required for correctness, because a
 * stale bucket is reset by its own window rollover on next use.
 */
export async function pruneRateLimitBuckets(olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
  try {
    // `db.execute` resolves to the pg QueryResult for this driver.
    const result = (await db.execute(sql`
      DELETE FROM rate_limit_buckets
      WHERE updated_at < now() - (${olderThanMs}::bigint * interval '1 millisecond')
    `)) as unknown as { rowCount?: number };
    return typeof result.rowCount === "number" ? result.rowCount : 0;
  } catch (error) {
    // Housekeeping only. Never fail a request because of it.
    console.warn("[nexa] rate-limit prune failed:", error);
    return 0;
  }
}
