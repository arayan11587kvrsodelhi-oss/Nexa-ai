/**
 * NEXA AI Gateway — rate-limit guard for the `/v1` surface.
 *
 * Ordering matters and is the security-relevant part:
 *
 *   authenticate → rate limit → work
 *
 * A request with a bad key must get 401, never 429, and must never consume a
 * valid user's quota. So the limiter is only reached once a principal exists,
 * and it is keyed by the *resolved* key id — never by the raw key, which must
 * not be used as a bucket key or land in a database row.
 *
 * One inbound request costs exactly one unit per dimension. The gateway's own
 * provider retries and fallbacks happen further down and are budgeted
 * separately, so they cannot inflate a caller's usage.
 */
import type { RateLimitDecision, RateLimitPolicy } from "./rate-limit";
import { consume, consumeAll, rateLimitConfig } from "./rate-limit";
import { GatewayError } from "./errors";
import { NEXA_API_KEY_PREFIX } from "./api-keys";

/** Buckets are prefixed by scope so unrelated limits cannot collide. */
const SCOPE = "v1";

/**
 * Resolve the caller's address for rate-limit bucketing.
 *
 * Trust boundary: these headers are only trustworthy because the platform edge
 * (Vercel) overwrites them before the function runs. `x-forwarded-for` is a
 * *client-settable* header on a directly-exposed origin — a spoofed value can
 * only ever move a caller into a different bucket, never skip a check, so the
 * blast radius of a forged header is one bucket, not unlimited access. The
 * value is truncated and normalised so it cannot bloat a row.
 */
export function clientAddress(headers: Headers): string {
  const candidates = [
    // Vercel's edge-set client address.
    headers.get("x-vercel-forwarded-for"),
    headers.get("x-real-ip"),
    headers.get("x-forwarded-for"),
  ];

  for (const raw of candidates) {
    if (!raw) continue;
    // Only the first hop is meaningful; the rest is a chain of proxies.
    const first = raw.split(",")[0]?.trim();
    if (!first) continue;
    // Bound the length so a hostile header cannot grow a primary key.
    if (first.length > 64) return first.slice(0, 64);
    if (!/^[0-9a-fA-F:.]{2,64}$/.test(first)) continue; // not an address; ignore
    return first;
  }
  return "unknown";
}

function bucketKeyFor(dimension: "key" | "ip", value: string): string {
  return `${SCOPE}:${dimension}:${value}`;
}

/**
 * The key id is a random 16-hex public id, never the secret, so it is safe as a
 * bucket key. A defensive strip keeps a full `nexa_sk_…` value out of the
 * database even if a future caller passes one.
 */
function keyBucketIdentity(keyId: string): string {
  if (keyId.startsWith(NEXA_API_KEY_PREFIX)) {
    throw new Error("Rate-limit bucket identity must be a key id, not a raw key.");
  }
  return keyId.slice(0, 64);
}

export interface GuardOptions {
  /** Which limiter applies to this endpoint. */
  kind: "chat" | "models" | "health";
  /** Resolved principal. Only called after authentication succeeds. */
  principal: { keyId: string; userId: string };
  request: Request;
}

/**
 * Consume the request's quota, or throw a client-safe 429.
 *
 * Throwing (rather than returning a boolean) keeps every call site honest: the
 * only two outcomes are "work proceeds" or "an error response is produced".
 */
export async function enforceRateLimit({
  kind,
  principal,
  request,
}: GuardOptions): Promise<RateLimitDecision> {
  const config = rateLimitConfig();

  const buckets: Array<{ bucketKey: string; policy: RateLimitPolicy }> = [
    {
      bucketKey: bucketKeyFor("key", keyBucketIdentity(principal.keyId)),
      policy: kind === "chat" ? config.chat.key : config[kind],
    },
  ];

  // Chat is the only endpoint that spends upstream quota, so it is the only one
  // with a second, per-source dimension.
  if (kind === "chat") {
    buckets.push({
      bucketKey: bucketKeyFor("ip", clientAddress(request.headers)),
      policy: config.chat.ip,
    });
  }

  const decision = await consumeAll(buckets);
  if (!decision.allowed) {
    // A store outage is reported as a service failure, not a throttle. The
    // client did not exhaust a quota, and telling it to slow down would mask a
    // real outage as an ordinary limit. The message names no infrastructure.
    if (decision.deniedByStoreFailure) {
      throw new GatewayError(
        "GatewayError",
        "The gateway is temporarily unable to accept requests. Please retry shortly.",
        {
          category: "temporary_upstream_failure",
          status: 503,
          details: { retryAfterSeconds: decision.retryAfterSeconds },
        }
      );
    }

    throw new GatewayError("RateLimited", "Rate limit exceeded.", {
      category: "rate_limit",
      // Carried through so the route can set Retry-After without recomputing.
      details: {
        retryAfterSeconds: decision.retryAfterSeconds,
        limit: decision.limit,
        remaining: decision.remaining,
      },
    });
  }
  return decision;
}

/**
 * Quota for API-key creation from the signed-in settings UI.
 *
 * Keyed by the *server-resolved* user id, so a client cannot move itself into
 * another account's bucket, and an unauthenticated request never reaches this
 * (the route authenticates first).
 *
 * Unlike `enforceRateLimit` this does not throw: the settings surface reports
 * failures with `ApiError`, not the gateway's `GatewayError` envelope, so the
 * caller decides how to phrase the refusal. It still returns the same decision
 * shape, so the caller must check `allowed`.
 */
export async function checkApiKeyCreationLimit(userId: string): Promise<RateLimitDecision> {
  return consume("apikey:create:" + userId.slice(0, 64), rateLimitConfig().apiKeyCreate);
}

/** Which session-authenticated `/api/*` limit to charge. */
export type SessionLimitKind = "tools" | "search";

/**
 * Charge a two-dimension quota (per user **and** per source address).
 *
 * Shared by the routes that need both, so there is exactly one place that knows
 * how a user bucket and an address bucket are named and combined. Adding a
 * second copy of this would be a second place to keep in sync, and the two
 * would eventually disagree about bucket keys — which is how a quota silently
 * stops being enforced.
 *
 * Both buckets are always consumed, so one client request costs exactly one
 * unit per dimension regardless of which one refuses.
 */
async function consumeUserAndAddress(
  scope: string,
  policies: { user: RateLimitPolicy; ip: RateLimitPolicy },
  userId: string,
  headers: Headers
): Promise<RateLimitDecision> {
  return consumeAll([
    { bucketKey: `${scope}:user:${userId.slice(0, 64)}`, policy: policies.user },
    { bucketKey: bucketKeyFor("ip", clientAddress(headers)), policy: policies.ip },
  ]);
}

/**
 * Quota for the interactive chat route, charged on **both** dimensions.
 *
 * Ordering is the security-relevant part and is enforced by the route: this is
 * only ever called after `requireUser` has resolved a principal, so an
 * unauthenticated request can never spend a signed-in user's quota. Like
 * `checkSessionLimit` it does not throw, because these routes report through
 * `ApiError` rather than the gateway envelope, and the caller phrases the
 * refusal — which matters here, because the two refusals mean different things:
 * an exhausted quota is 429, an unreachable store is 503.
 */
export async function checkChatSessionLimit(
  userId: string,
  headers: Headers
): Promise<RateLimitDecision> {
  return consumeUserAndAddress("chat", rateLimitConfig().chatSession, userId, headers);
}

/**
 * Quota for `POST /api/agents`, charged on both dimensions.
 *
 * This exists because the agent route reaches the *same* tool implementations
 * (`web_search`, `file_search`) that `/api/tools` and `/api/search` limit, but
 * does so by calling `ToolExecutor.execute` directly. A limiter on those two
 * HTTP routes cannot see an agent-originated tool call, so without this the
 * agent was a way around both of them.
 *
 * It is a **request-level** quota, deliberately separate from the tool
 * endpoints' own quotas: an agent run is a different operation from a direct
 * tool invocation, and both are bounded. This is not a second charge for the
 * same work — the agent's internal tool call is not separately limited, because
 * the orchestrator's execution is structurally capped at exactly one tool call
 * (see `orchestrator.ts`).
 */
export async function checkAgentSessionLimit(
  userId: string,
  headers: Headers
): Promise<RateLimitDecision> {
  return consumeUserAndAddress("agent", rateLimitConfig().agent, userId, headers);
}

/**
 * Quota for `POST /api/files`, charged on both dimensions.
 *
 * Added in Phase 5.4 after verifying the route had no application-level limit
 * while performing per-chunk embedding work and unbounded storage growth on
 * every accepted upload.
 */
export async function checkFileUploadLimit(
  userId: string,
  headers: Headers
): Promise<RateLimitDecision> {
  return consumeUserAndAddress("files", rateLimitConfig().fileUpload, userId, headers);
}

/**
 * Quota for a session-authenticated `/api/*` route.
 *
 * Keyed by the *server-resolved* user id, never by a header or body value, so a
 * client cannot move itself into another account's bucket. Like
 * `checkApiKeyCreationLimit` this does not throw: these routes report failures
 * through `ApiError`, not the gateway's `GatewayError` envelope, so the caller
 * phrases the refusal. The decision shape is identical, so the caller must
 * still check `allowed`.
 *
 * Authentication has already happened by the time this is called, which
 * preserves the ordering the whole limiter depends on: a 401 never consumes a
 * valid user's quota.
 */
export async function checkSessionLimit(
  kind: SessionLimitKind,
  userId: string
): Promise<RateLimitDecision> {
  const config = rateLimitConfig();
  const policy = kind === "tools" ? config.tools : config.search;
  // Prefixed by kind so the two limits cannot share a bucket.
  return consume(`session:${kind}:${userId.slice(0, 64)}`, policy);
}

/**
 * Headers for a rejected client. Never contains limiter internals.
 *
 * For a store outage there is no meaningful quota to report, so only
 * `Retry-After` is sent — advertising a limit of 0 would be misleading.
 */
export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!decision.storeUnavailable) {
    headers["X-RateLimit-Limit"] = String(decision.limit);
    headers["X-RateLimit-Remaining"] = String(decision.remaining);
  }
  if (decision.retryAfterSeconds > 0) {
    headers["Retry-After"] = String(decision.retryAfterSeconds);
  }
  return headers;
}

/**
 * True when the error originated from the limiter — either an exhausted quota or
 * a fail-closed store outage.
 *
 * Identification is by the limiter's own marker rather than by status, so the
 * 503 outage case is recognised too, while authentication failures and provider
 * errors (which carry no limiter details) are not mistaken for throttles.
 */
export function isRateLimitRejection(error: GatewayError): boolean {
  return error.details?.retryAfterSeconds !== undefined;
}

/**
 * The same headers, recovered from a rejection a route has already caught.
 *
 * The limiter's numbers travelled on the error as safe extras, so a route can
 * report `Retry-After` without re-reading the store (which could itself fail and
 * would turn an error path into a second database round trip).
 */
export function rateLimitHeadersFor(error: GatewayError): Record<string, string> {
  const details = error.details ?? {};
  // Whether this is a quota rejection or a store outage is inferred from the
  // error's own category: only a real quota rejection has a limit to report.
  const isQuotaRejection = error.category === "rate_limit";
  return rateLimitHeaders({
    allowed: false,
    retryAfterSeconds: Number(details.retryAfterSeconds ?? 1),
    limit: Number(details.limit ?? 0),
    remaining: Number(details.remaining ?? 0),
    storeUnavailable: !isQuotaRejection,
    deniedByStoreFailure: !isQuotaRejection,
  });
}
