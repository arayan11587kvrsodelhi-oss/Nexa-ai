/**
 * Phase 5.2 — `POST /api/chat` limits against a REAL PostgreSQL database.
 *
 * The unit suite proves the route's ordering and status semantics with a store
 * double. This proves the thing a double cannot: that the atomic upsert
 * serialises under genuine parallel load, so concurrent chat requests cannot
 * all read the same stale counter and over-admit.
 *
 * Exercises `checkChatSessionLimit` and `consume` directly — the same code the
 * route calls, with no route or provider in the way.
 */
import "dotenv/config";
import { consume, rateLimitConfig } from "./src/lib/gateway/rate-limit.ts";
import { checkChatSessionLimit } from "./src/lib/gateway/rate-limit-guard.ts";

const USER = `usr_chat_probe_${Date.now()}`;
const IP = "203.0.113.77";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function headersFor(ip: string): Headers {
  return new Headers({ "x-forwarded-for": ip });
}

async function main(): Promise<void> {
  const config = rateLimitConfig();

  // --- Concurrency: the property a read-then-write limiter would fail -----
  {
    const limit = 10;
    const policy = { ...config.chatSession.user, limit, windowSeconds: 60 };
    const bucket = `chat:user:concurrent_${Date.now()}`;

    // 40 simultaneous requests against a limit of 10.
    const decisions = await Promise.all(
      Array.from({ length: 40 }, () => consume(bucket, policy))
    );
    const allowed = decisions.filter((d) => d.allowed).length;
    check(
      "concurrent chat requests admit exactly the limit",
      allowed === limit,
      `allowed=${allowed} expected=${limit}`
    );

    // Every refusal must carry a positive retry hint and no internal detail.
    const denied = decisions.filter((d) => !d.allowed);
    check(
      "every refusal carries Retry-After",
      denied.every((d) => d.retryAfterSeconds > 0)
    );
    check(
      "no refusal leaks store internals",
      denied.every((d) => !("sql" in (d as unknown as Record<string, unknown>)))
    );
  }

  // --- Per-user dimension, sequentially, through the real guard -----------
  {
    // A small configured limit keeps this fast.
    process.env.NEXA_CHAT_USER_RATE_LIMIT = "4";
    // The window is pinned to an hour for this probe only. At the default 60s
    // the loop (6 requests x 2 buckets = 12 round trips) occasionally
    // straddles a window boundary, which resets the counter mid-run and makes
    // the outcome depend on machine speed. The property under test is *where
    // the first denial happens*, not the window length.
    process.env.NEXA_CHAT_USER_RATE_WINDOW_SECONDS = "3600";
    const user = `${USER}_seq`;
    const limit = rateLimitConfig().chatSession.user.limit;
    const statuses: boolean[] = [];
    for (let i = 0; i < limit + 2; i += 1) {
      const decision = await checkChatSessionLimit(user, headersFor("198.51.100.5"));
      statuses.push(decision.allowed);
    }
    check(
      "sequential requests are allowed up to the per-user limit",
      statuses.slice(0, limit).every(Boolean) && !statuses[limit] && !statuses[limit + 1],
      `first-denied-at=${statuses.indexOf(false)} expected=${limit}`
    );
    delete process.env.NEXA_CHAT_USER_RATE_LIMIT;
    delete process.env.NEXA_CHAT_USER_RATE_WINDOW_SECONDS;
  }

  // --- Isolation between users on the same address -----------------------
  {
    const ip = "198.51.100.42";
    const decision = await checkChatSessionLimit(`${USER}_iso_a`, headersFor(ip));
    check("a fresh user on a fresh address is allowed", decision.allowed);
    const other = await checkChatSessionLimit(`${USER}_iso_b`, headersFor(ip));
    check("a different user sharing that address is allowed", other.allowed);
  }

  // --- Per-IP dimension is shared across users ---------------------------
  {
    // Small configured limit for the same reason as above: this probe must not
    // depend on how fast the machine issues round trips.
    process.env.NEXA_CHAT_IP_RATE_LIMIT = "3";
    const ip = `198.51.100.${90 + (Date.now() % 8)}`;
    const limit = rateLimitConfig().chatSession.ip.limit;
    let deniedFor: string | null = null;
    // A distinct user each time so the per-user bucket never binds; the shared
    // address budget must be what refuses.
    for (let i = 0; i < limit + 2; i += 1) {
      const decision = await checkChatSessionLimit(`${USER}_ip_${i}_${Date.now()}`, headersFor(ip));
      if (!decision.allowed && deniedFor === null) {
        deniedFor = `usr_ip_${i}`;
      }
    }
    check(
      "the shared address budget refuses even distinct users",
      deniedFor !== null,
      `no user was refused across ${limit + 2} distinct users on one address`
    );
    delete process.env.NEXA_CHAT_IP_RATE_LIMIT;
  }

  // --- A refused decision is distinguishable from a store outage ---------
  {
    const user = `${USER}_shape`;
    const limit = config.chatSession.user.limit;
    let last = await checkChatSessionLimit(user, headersFor("198.51.100.11"));
    for (let i = 0; i < limit; i += 1) {
      last = await checkChatSessionLimit(user, headersFor("198.51.100.11"));
    }
    check("an exhausted quota is not reported as a store outage", !last.deniedByStoreFailure);
    check("an exhausted quota is not flagged storeUnavailable", !last.storeUnavailable);
    check("an exhausted quota reports zero remaining", last.remaining === 0);
  }

  // --- Unknown address collapses into one shared bucket ------------------
  {
    const bare = new Headers();
    const a = await checkChatSessionLimit(`${USER}_bare`, bare);
    const b = await checkChatSessionLimit(`${USER}_bare_2`, bare);
    check("requests with no address header are still allowed", a.allowed && b.allowed);
  }

  console.log(`\n${passed}/${passed + failed} chat rate-limit integration checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("chat rate-limit integration failed:", error);
  process.exitCode = 1;
});
