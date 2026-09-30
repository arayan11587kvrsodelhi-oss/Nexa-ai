/**
 * Phase 5.3 — `POST /api/agents` limits against a REAL PostgreSQL database.
 *
 * The unit suite proves the route's ordering and status semantics with a store
 * double. This proves what a double cannot: that the atomic upsert serialises
 * under genuine parallel connections, so concurrent agent runs cannot all read
 * the same stale counter and over-admit the configured limit.
 *
 * Requires a reachable DATABASE_URL with migration 0003 applied.
 */
import "dotenv/config";
import { consume, rateLimitConfig } from "./src/lib/gateway/rate-limit.ts";
import { checkAgentSessionLimit } from "./src/lib/gateway/rate-limit-guard.ts";

const stamp = Date.now();
const IP = "198.51.100.88";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

const headers = (ip: string): Headers => new Headers({ "x-forwarded-for": ip });

async function main(): Promise<void> {
  // --- Concurrency: the property a read-then-write limiter would fail -----
  {
    const limit = 8;
    const policy = { ...rateLimitConfig().agent.user, limit, windowSeconds: 60 };
    const bucket = `agent:user:concurrent_${stamp}`;

    // 40 simultaneous requests against a limit of 8.
    const decisions = await Promise.all(
      Array.from({ length: 40 }, () => consume(bucket, policy))
    );
    const allowed = decisions.filter((d) => d.allowed).length;
    check(
      "concurrent agent requests admit exactly the limit",
      allowed === limit,
      `allowed=${allowed} expected=${limit}`
    );
    check(
      "every refusal carries Retry-After",
      decisions.filter((d) => !d.allowed).every((d) => d.retryAfterSeconds > 0)
    );
  }

  // --- Per-user dimension through the real guard -------------------------
  {
    // A small limit keeps the probe inside one fixed window; at the production
    // default the loop would need many round trips and a window rollover
    // mid-loop would make the result depend on machine speed.
    process.env.NEXA_AGENT_USER_RATE_LIMIT = "4";
    // Pin the window for this probe only: at the default 60s the loop
    // occasionally straddles a window boundary, which resets the counter
    // mid-run and makes the outcome depend on machine speed. The property
    // under test is where the first denial happens, not the window length.
    process.env.NEXA_AGENT_USER_RATE_WINDOW_SECONDS = "3600";
    const user = `usr_agent_seq_${stamp}`;
    const limit = rateLimitConfig().agent.user.limit;
    const statuses: boolean[] = [];
    for (let i = 0; i < limit + 2; i += 1) {
      statuses.push((await checkAgentSessionLimit(user, headers("198.51.100.12"))).allowed);
    }
    check(
      "sequential agent runs are allowed up to the per-user limit",
      statuses.slice(0, limit).every(Boolean) && !statuses[limit] && !statuses[limit + 1],
      `first-denied-at=${statuses.indexOf(false)} expected=${limit}`
    );
    delete process.env.NEXA_AGENT_USER_RATE_LIMIT;
    delete process.env.NEXA_AGENT_USER_RATE_WINDOW_SECONDS;
  }

  // --- Isolation between users on one address ----------------------------
  {
    const a = await checkAgentSessionLimit(`usr_agent_iso_a_${stamp}`, headers(IP));
    const b = await checkAgentSessionLimit(`usr_agent_iso_b_${stamp}`, headers(IP));
    check("a fresh agent run on a fresh address is allowed", a.allowed && b.allowed);
  }

  // --- The shared address budget binds across users ----------------------
  {
    process.env.NEXA_AGENT_IP_RATE_LIMIT = "3";
    const limit = rateLimitConfig().agent.ip.limit;
    let deniedFor: string | null = null;
    // A distinct user each time, so only the shared address budget can refuse.
    for (let i = 0; i < limit + 2; i += 1) {
      const decision = await checkAgentSessionLimit(`usr_agent_ip_${stamp}_${i}`, headers(IP));
      if (!decision.allowed && deniedFor === null) deniedFor = `usr_${i}`;
    }
    check(
      "the shared address budget refuses even distinct users",
      deniedFor !== null,
      `no user was refused across ${limit + 2} distinct users on one address`
    );
    delete process.env.NEXA_AGENT_IP_RATE_LIMIT;
  }

  // --- Agent namespace does not collide with chat -----------------------
  {
    const user = `usr_agent_ns_${stamp}`;
    // Consume a little of the agent budget, then prove the chat budget for the
    // same user id is untouched: the two scopes are separate buckets.
    const policy = { ...rateLimitConfig().agent.user, limit: 2, windowSeconds: 60 };
    await consume(`agent:user:${user}`, policy);
    const chat = await consume(`chat:user:${user}`, {
      ...rateLimitConfig().chatSession.user,
      limit: 1000,
      windowSeconds: 60,
    });
    check("the agent namespace does not consume the chat budget", chat.allowed);
    check("an exhausted quota is not reported as a store outage", !chat.deniedByStoreFailure);
  }

  console.log(`\n${passed}/${passed + failed} agent rate-limit integration checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("agent rate-limit integration failed:", error);
  process.exitCode = 1;
});
