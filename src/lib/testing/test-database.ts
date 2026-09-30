/**
 * Phase 7.1 — test-database safety.
 *
 * ## The hazard this exists to prevent
 *
 * Vitest loads `.env` into `process.env`, so `DATABASE_URL` — the operator's
 * *configured* database, which in a real deployment is a remote production
 * instance — is present in **every** test run. Any test that reads it and
 * writes to it therefore creates real users, real API keys and real rows in
 * production data, with no warning and no way to tell from the test output.
 *
 * That is not hypothetical. `password-reset.test.ts` self-gates on
 * `if (!process.env.DATABASE_URL) return;` and then performs a live insert →
 * reset → reuse round trip. It is a `*.test.ts`, so it runs on every
 * `npm test`. It writes to whatever database is configured.
 *
 * ## The rule
 *
 * Automated tests may only ever touch a database that was **explicitly**
 * designated for testing, via `TEST_DATABASE_URL`. There is deliberately no
 * fallback to `DATABASE_URL`: a silent fallback is exactly the failure mode
 * being closed. If no test database is configured, tests skip — loudly —
 * rather than guessing.
 *
 * A test database must additionally be loopback, unless an operator opts out
 * of that restriction for a genuinely remote ephemeral test instance.
 */

/** Environment variables that may designate the test database, in order. */
const TEST_URL_KEYS = ["NEXA_TEST_DATABASE_URL", "TEST_DATABASE_URL"] as const;

/** Opt-in for a deliberately remote, disposable test instance. */
const REMOTE_OPT_IN = "NEXA_ALLOW_REMOTE_TEST_DATABASE";

export interface DatabaseTarget {
  /** Host as written in the URL. */
  host: string;
  port: string;
  /** Database name only — never credentials, never the full URL. */
  database: string;
  /** True for localhost / 127.0.0.0/8 / ::1. */
  isLoopback: boolean;
  /** True when a known production host pattern is matched. */
  looksLikeProduction: boolean;
}

/** Hostname suffixes that indicate a managed/production database. */
const PRODUCTION_HOST_HINTS = [
  "neon.tech",
  "supabase.co",
  "amazonaws.com",
  "rds.amazonaws.com",
  "azure.com",
  "cloudsql.",
  "digitalocean.com",
  "planetscale.com",
  "railway.app",
  "onrender.com",
  "fly.dev",
  "herokuapp.com",
];

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  // 127.0.0.0/8
  if (/^127(?:\.\d{1,3}){3}$/.test(h)) return true;
  return false;
}

/**
 * Parse a Postgres URL into the fields the safety decision needs.
 *
 * Returns `null` for anything unparseable so the caller fails closed.
 * Credentials are read but never propagated: they stay inside `URL`, and only
 * host / port / database leave this function.
 */
export function classifyDatabaseUrl(raw: string | undefined | null): DatabaseTarget | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return null;

  const host = parsed.hostname;
  const lower = host.toLowerCase();

  return {
    host,
    port: parsed.port || "5432",
    database: parsed.pathname.replace(/^\//, "") || "(default)",
    isLoopback: isLoopbackHost(host),
    looksLikeProduction: PRODUCTION_HOST_HINTS.some((hint) => lower.includes(hint)),
  };
}

/** The slice of the environment this module reads. */
export type Env = Record<string, string | undefined>;

export interface TestDatabaseResolution {
  /** True only when a test database is configured *and* safe to use. */
  usable: boolean;
  target: DatabaseTarget | null;
  /** Human-readable reason, safe to print. Contains no credentials. */
  reason: string;
}

/**
 * Resolve the test database, or explain why there is not one.
 *
 * Never reads `DATABASE_URL`. Never guesses. Never falls back.
 */
export function resolveTestDatabase(
  env: Env = process.env
): TestDatabaseResolution {
  const configured = TEST_URL_KEYS.map((k) => env[k]).find((v) => v && v.trim());
  if (!configured) {
    return {
      usable: false,
      target: null,
      reason:
        `No test database configured. Set ${TEST_URL_KEYS[0]} (or ${TEST_URL_KEYS[1]}) ` +
        `to a disposable database. Tests that need a database are skipped; ` +
        `DATABASE_URL is never used as a fallback.`,
    };
  }

  const target = classifyDatabaseUrl(configured);
  if (!target) {
    return {
      usable: false,
      target: null,
      reason: `${TEST_URL_KEYS[0]} is not a valid postgres:// or postgresql:// URL.`,
    };
  }

  if (target.looksLikeProduction) {
    return {
      usable: false,
      target,
      reason:
        `Refusing to run: the configured test database host looks like a managed ` +
        `production instance. Point ${TEST_URL_KEYS[0]} at a disposable database.`,
    };
  }

  if (!target.isLoopback && env[REMOTE_OPT_IN] !== "true") {
    return {
      usable: false,
      target,
      reason:
        `Refusing to run: the test database host "${target.host}" is not loopback. ` +
        `Use a local database, or set ${REMOTE_OPT_IN}=true if it is a disposable ` +
        `remote instance you have confirmed can be dropped.`,
    };
  }

  return {
    usable: true,
    target,
    reason: `Test database ready: ${target.database} on ${target.host}:${target.port} (${target.isLoopback ? "loopback" : "remote, opted in"}).`,
  };
}

/**
 * Throw when the test database is unusable.
 *
 * Used by the integration runner, which must abort rather than continue.
 */
export function assertTestDatabaseUsable(
  env: Env = process.env
): DatabaseTarget {
  const resolution = resolveTestDatabase(env);
  if (!resolution.usable || !resolution.target) {
    throw new Error(`[nexa] integration tests aborted.\n${resolution.reason}`);
  }
  return resolution.target;
}
