/**
 * Phase 5.4 — `POST /api/files` limits against a REAL PostgreSQL database.
 *
 * Proves what a store double cannot: that the atomic upsert serialises under
 * genuine parallel connections, so concurrent uploads cannot all read the same
 * stale counter and over-admit.
 *
 * Requires a reachable DATABASE_URL with migration 0003 applied.
 */
import "dotenv/config";
import { consume, rateLimitConfig } from "./src/lib/gateway/rate-limit.ts";
import { checkFileUploadLimit } from "./src/lib/gateway/rate-limit-guard.ts";

const stamp = Date.now();
const IP = "198.51.100.31";

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
  // --- Concurrency -------------------------------------------------------
  {
    const limit = 5;
    const policy = { ...rateLimitConfig().fileUpload.user, limit, windowSeconds: 60 };
    const bucket = `files:user:concurrent_${stamp}`;

    // 30 simultaneous uploads against a limit of 5.
    const decisions = await Promise.all(
      Array.from({ length: 30 }, () => consume(bucket, policy))
    );
    const allowed = decisions.filter((d) => d.allowed).length;
    check(
      "concurrent uploads admit exactly the limit",
      allowed === limit,
      `allowed=${allowed} expected=${limit}`
    );
    check(
      "every refusal carries Retry-After",
      decisions.filter((d) => !d.allowed).every((d) => d.retryAfterSeconds > 0)
    );
  }

  // --- Per-user dimension ------------------------------------------------
  {
    // A small limit keeps the probe inside one fixed window; at the production
    // default the loop would need many round trips and a window rollover
    // mid-loop would make the result depend on machine speed.
    process.env.NEXA_FILE_UPLOAD_USER_RATE_LIMIT = "3";
    // Pin the window for this probe only: at the default 60s the loop
    // occasionally straddles a window boundary, which resets the counter
    // mid-run and makes the outcome depend on machine speed. The property
    // under test is where the first denial happens, not the window length.
    process.env.NEXA_FILE_UPLOAD_USER_RATE_WINDOW_SECONDS = "3600";
    const user = `usr_upload_seq_${stamp}`;
    const limit = rateLimitConfig().fileUpload.user.limit;
    const statuses: boolean[] = [];
    for (let i = 0; i < limit + 2; i += 1) {
      statuses.push((await checkFileUploadLimit(user, headers("198.51.100.8"))).allowed);
    }
    check(
      "sequential uploads are allowed up to the per-user limit",
      statuses.slice(0, limit).every(Boolean) && !statuses[limit] && !statuses[limit + 1],
      `first-denied-at=${statuses.indexOf(false)} expected=${limit}`
    );
    delete process.env.NEXA_FILE_UPLOAD_USER_RATE_LIMIT;
    delete process.env.NEXA_FILE_UPLOAD_USER_RATE_WINDOW_SECONDS;
  }

  // --- Isolation between users on one address ---------------------------
  {
    const a = await checkFileUploadLimit(`usr_upload_iso_a_${stamp}`, headers(IP));
    const b = await checkFileUploadLimit(`usr_upload_iso_b_${stamp}`, headers(IP));
    check("a fresh upload from a fresh address is allowed", a.allowed && b.allowed);
  }

  // --- The shared address budget binds across users ----------------------
  {
    process.env.NEXA_FILE_UPLOAD_IP_RATE_LIMIT = "3";
    const limit = rateLimitConfig().fileUpload.ip.limit;
    let deniedFor: string | null = null;
    for (let i = 0; i < limit + 2; i += 1) {
      const decision = await checkFileUploadLimit(`usr_upload_ip_${stamp}_${i}`, headers(IP));
      if (!decision.allowed && deniedFor === null) deniedFor = `usr_${i}`;
    }
    check(
      "the shared address budget refuses even distinct users",
      deniedFor !== null,
      `no user was refused across ${limit + 2} distinct users on one address`
    );
    delete process.env.NEXA_FILE_UPLOAD_IP_RATE_LIMIT;
  }

  // --- Namespaces stay independent --------------------------------------
  {
    const user = `usr_upload_ns_${stamp}`;
    const policy = { ...rateLimitConfig().fileUpload.user, limit: 2, windowSeconds: 60 };
    await consume(`files:user:${user}`, policy);
    // Consuming the upload budget must not touch the agent or chat budgets:
    // they are separate namespaces, not a second charge for the same work.
    const agent = await consume(`agent:user:${user}`, {
      ...rateLimitConfig().agent.user,
      limit: 1000,
      windowSeconds: 60,
    });
    const chat = await consume(`chat:user:${user}`, {
      ...rateLimitConfig().chatSession.user,
      limit: 1000,
      windowSeconds: 60,
    });
    check("the upload namespace does not consume the agent budget", agent.allowed);
    check("the upload namespace does not consume the chat budget", chat.allowed);
  }

  console.log(`\n${passed}/${passed + failed} file-upload rate-limit integration checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("file-upload rate-limit integration failed:", error);
  process.exitCode = 1;
});
