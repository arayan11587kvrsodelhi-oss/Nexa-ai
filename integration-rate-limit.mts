/**
 * Distributed rate limiting against the REAL PostgreSQL database.
 *
 * The unit tests prove the decision logic against a store double. This proves
 * the thing the double cannot: that the single-statement upsert really is
 * atomic under genuine parallel connections, so the configured limit is not
 * exceeded by a concurrent flood.
 *
 * Here the real connection pool is used, so the `Promise.all` calls are real
 * concurrent statements, not interleaved microtasks. Requires a reachable
 * DATABASE_URL with migration 0003 applied.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "./src/db/index.ts";
import {
  consume,
  consumeAll,
  pruneRateLimitBuckets,
  rateLimitConfig,
  windowStart,
} from "./src/lib/gateway/rate-limit.ts";

const results: string[] = [];
const check = (name: string, pass: boolean, detail = ""): void => {
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const stamp = Date.now();
/** Unique per run, so a concurrent run cannot share buckets. */
const bucket = (name: string) => `itest:${stamp}:${name}`;

const policy = (limit: number, windowSeconds = 60) => ({
  dimension: "key" as const,
  limit,
  windowSeconds,
  failClosed: true,
});

/** Read one row's counter back, to prove the state is really in PostgreSQL. */
async function storedCount(key: string): Promise<number> {
  const result = await db.execute(
    sql`SELECT count FROM rate_limit_buckets WHERE bucket_key = ${key}`
  );
  return Number((result as unknown as { rows: Array<{ count: number }> }).rows[0]?.count ?? -1);
}

try {
  // ---- the table exists and matches the migration -----------------------
  const exists = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'rate_limit_buckets'
  `);
  const columns = (exists as unknown as { rows: Array<{ column_name: string }> }).rows.map(
    (r) => r.column_name
  );
  check("rate_limit_buckets table exists", columns.length > 0, columns.join(","));
  check(
    "table has the columns the limiter depends on",
    ["bucket_key", "window_start", "count"].every((c) => columns.includes(c))
  );

  // ---- per-key, on a real connection ------------------------------------
  {
    const key = bucket("key");
    const p = policy(3);
    const first = await consume(key, p);
    await consume(key, p);
    await consume(key, p);
    const fourth = await consume(key, p);

    check("requests within the limit are allowed", first.allowed);
    check("the request beyond the limit is refused", !fourth.allowed);
    check("remaining is reported as 0 at the limit", fourth.remaining === 0);
    check("Retry-After is computable on a real clock", fourth.retryAfterSeconds > 0,
      `${fourth.retryAfterSeconds}s`);
    // Real state in PostgreSQL, not process memory.
    check("the counter is persisted in PostgreSQL", (await storedCount(key)) === 4,
      `count=${await storedCount(key)}`);
  }

  // ---- per-IP across different keys -------------------------------------
  {
    const ip = bucket("ip");
    const p = { ...policy(2), dimension: "ip" as const };
    await consume(ip, p);
    await consume(ip, p);
    check("a shared address bucket refuses past its limit", !(await consume(ip, p)).allowed);
  }

  // ---- isolation --------------------------------------------------------
  {
    const p = policy(1);
    const a = bucket("iso-a");
    const b = bucket("iso-b");
    const firstA = await consume(a, p);
    const secondA = await consume(a, p);
    const firstB = await consume(b, p);
    check(
      "one key's exhaustion does not affect another",
      firstA.allowed && !secondA.allowed && firstB.allowed
    );
  }

  // ---- window rollover, with real persisted state -----------------------
  {
    const key = bucket("rollover");
    const p = policy(1, 60);
    await consume(key, p);
    check("second request in the same window is refused", !(await consume(key, p)).allowed);

    // Backdate the stored window by hand, exactly as the passage of time would.
    const stale = windowStart(Date.now(), 60) - 60_000;
    await db.execute(
      sql`UPDATE rate_limit_buckets SET window_start = ${stale}, count = 99 WHERE bucket_key = ${key}`
    );

    const afterRollover = await consume(key, p);
    check("an expired window is refreshed instead of carried forward", afterRollover.allowed);
    check("the stale count is reset to 1", afterRollover.remaining === 0);
  }

  // ---- CONCURRENCY: the real guarantee -----------------------------------
  {
    // 40 genuinely parallel statements against one bucket, limit 10.
    // A read-then-write limiter would admit far more than 10 here.
    const key = bucket("race");
    const decisions = await Promise.all(
      Array.from({ length: 40 }, () => consume(key, policy(10)))
    );
    const allowed = decisions.filter((d) => d.allowed).length;

    check(
      "concurrent requests do not exceed the limit",
      allowed === 10,
      `admitted ${allowed} of 40 with a limit of 10`
    );
    const count = await storedCount(key);
    check("every concurrent request is counted, including refusals", count === 40, `count=${count}`);
  }

  // ---- concurrency across many keys -------------------------------------
  {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => consume(bucket(`multi-${i % 3}`), policy(100)))
    );
    const perKey = await Promise.all([0, 1, 2].map((i) => storedCount(bucket(`multi-${i}`))));
    check(
      "concurrent keys keep independent counters",
      perKey.every((c) => c === 10),
      perKey.join(",")
    );
  }

  // ---- both dimensions under concurrency --------------------------------
  {
    const key = bucket("dim-key");
    const ip = bucket("dim-ip");
    const decisions = await Promise.all(
      Array.from({ length: 20 }, () =>
        consumeAll([
          { bucketKey: key, policy: policy(100) },
          { bucketKey: ip, policy: { ...policy(100), dimension: "ip" as const } },
        ])
      )
    );
    check(
      "a two-dimension request is admitted while both have room",
      decisions.every((d) => d.allowed)
    );
    const keyCount = await storedCount(key);
    const ipCount = await storedCount(ip);
    check(
      "both dimensions counted every request exactly once",
      keyCount === 20 && ipCount === 20,
      `key=${keyCount} ip=${ipCount}`
    );
  }

  // ---- configuration is read from the real environment ------------------
  {
    const config = rateLimitConfig();
    check("per-key chat limit is configured", config.chat.key.limit > 0, `${config.chat.key.limit}`);
    check("per-IP chat limit is configured", config.chat.ip.limit > 0, `${config.chat.ip.limit}`);
    // The security posture, asserted against the live configuration.
    check("chat fails closed on store failure", config.chat.key.failClosed);
    check("model listing fails open on store failure", !config.models.failClosed);
  }

  // ---- pruning ----------------------------------------------------------
  {
    const key = bucket("prune");
    await consume(key, policy(1));
    // Backdate far enough to be certainly stale.
    await db.execute(
      sql`UPDATE rate_limit_buckets SET updated_at = now() - interval '3 days'
          WHERE bucket_key = ${key}`
    );
    const deleted = await pruneRateLimitBuckets();
    check("pruning removed the stale row", (await storedCount(key)) === -1, `pruned=${deleted}`);

    // A live row must survive.
    const live = bucket("prune-live");
    await consume(live, policy(1));
    await pruneRateLimitBuckets();
    check("pruning kept a live row", (await storedCount(live)) === 1);
  }
} finally {
  // Only this run's rows, so a rerun starts from zero.
  await db.execute(sql`DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ${`itest:${stamp}:%`}`);
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(`\n${results.length - failed.length}/${results.length} rate-limit integration checks passed`);
if (failed.length) console.log("FAILED:\n" + failed.join("\n"));
process.exit(failed.length ? 1 : 0);

