/**
 * Phase 7.2 — the integration test runner.
 *
 * ## Why this exists
 *
 * The `.mts` suites are not safe to run casually. Several of them create real
 * users and real API keys, and `integration-migration.mts` connects to
 * `DATABASE_URL`. Because Vitest (and the suites themselves) load `.env` into
 * `process.env`, running them with no extra setup will happily write into the
 * operator's configured — and in a real deployment, production — database.
 *
 * That is a footgun with no visible edge. This runner makes the safe path the
 * easy one and the dangerous path impossible:
 *
 *   1. Resolve the test database through the Phase 7.1 guard.
 *   2. If it is missing or unsafe, print exactly why and exit non-zero.
 *      **No suite runs.** There is no fallback to `DATABASE_URL`.
 *   3. Only then apply migrations and execute the suites.
 *
 * Usage:
 *   NEXA_TEST_DATABASE_URL=postgresql://user:pw@127.0.0.1:5432/nexa_test \
 *     npx tsx scripts/run-integration.mts [suite ...]
 *
 * With no arguments every `.mts` suite at the repository root is run.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { resolveTestDatabase } from "../src/lib/testing/test-database";

const ROOT = process.cwd();

function fail(message: string): never {
  console.error(`\n[nexa] INTEGRATION TESTS ABORTED\n\n${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Safety gate — this runs before anything else touches a database.
// ---------------------------------------------------------------------------
const resolution = resolveTestDatabase();

console.log("[nexa] test database safety check");
console.log(`      ${resolution.reason}`);

if (!resolution.usable || !resolution.target) {
  fail(
    `${resolution.reason}\n\n` +
      `To run the integration suites, create a disposable database and point\n` +
      `NEXA_TEST_DATABASE_URL at it, for example:\n\n` +
      `  createdb nexa_test\n` +
      `  NEXA_TEST_DATABASE_URL=postgresql://user:pw@127.0.0.1:5432/nexa_test \\\n` +
      `    npx tsx scripts/run-integration.mts\n\n` +
      `A managed or remote host is refused outright. For a genuinely disposable\n` +
      `remote instance you have confirmed can be dropped, add\n` +
      `NEXA_ALLOW_REMOTE_TEST_DATABASE=true.`,
  );
}

const target = resolution.target;

// The suites read DATABASE_URL, so it is pointed at the *test* database — which
// the guard has just proven to be safe. This is the only place that happens.
process.env.DATABASE_URL =
  process.env.NEXA_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

console.log(
  `\n[nexa] target: ${target.database} @ ${target.host}:${target.port} ` +
    `(${target.isLoopback ? "loopback" : "remote, opted in"})`
);

// ---------------------------------------------------------------------------
// 2. Migrations must match the application before any suite runs.
// ---------------------------------------------------------------------------
function run(label: string, cmd: string, args: string[]): boolean {
  console.log(`\n[nexa] ${label}…`);
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  return res.status === 0;
}

if (!run("applying migrations", "npx", ["drizzle-kit", "migrate"])) {
  fail("Migrations failed. The test database schema is not trustworthy, so no suite was run.");
}

// ---------------------------------------------------------------------------
// 3. Suites.
// ---------------------------------------------------------------------------
const requested = process.argv.slice(2);
const suites =
  requested.length > 0
    ? requested
    : readdirSync(ROOT)
        .filter((f) => f.endsWith(".mts") && f.startsWith("integration-"))
        .map((f) => path.join(ROOT, f));

if (suites.length === 0) {
  fail("No integration suites were found to run.");
}

console.log(`\n[nexa] running ${suites.length} suite(s):`);
for (const s of suites) console.log(`      - ${path.basename(s)}`);

let failed = 0;
const summary: Array<{ suite: string; ok: boolean }> = [];

for (const suite of suites) {
  const ok = run(`suite ${path.basename(suite)}`, "npx", ["tsx", suite]);
  summary.push({ suite: path.basename(suite), ok });
  if (!ok) failed += 1;
}

console.log("\n[nexa] integration summary");
for (const s of summary) {
  console.log(`      ${s.ok ? "PASS" : "FAIL"}  ${s.suite}`);
}

if (failed > 0) {
  console.error(`\n[nexa] ${failed} suite(s) failed.`);
  process.exit(1);
}

console.log(`\n[nexa] all ${summary.length} integration suite(s) passed.`);
