/**
 * In-memory fixed-window rate limiter.
 *
 * Purpose: throttle authentication endpoints (login/signup) and other
 * unauthenticated-costly routes. This is a single-process guard — it is not a
 * substitute for a distributed limiter, but it stops trivial brute-force and
 * spam on a single-node deployment.
 *
 * Keyed by client IP (x-forwarded-for first hop, else the request origin).
 */
import type { NextRequest } from "next/server";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Periodically drop expired buckets so the map cannot grow without bound. */
let lastSweep = 0;
function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  sweep(now);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Prefixed helper so auth and chat limits do not collide. */
export function limitRequest(
  req: NextRequest,
  scope: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  return rateLimit(`${scope}:${clientIp(req)}`, limit, windowMs);
}
