/**
 * Migration review (Phase 7).
 *
 * The development database is only READ. The meaningful question is not "can
 * this SQL be replayed into a scratch schema" (already proven when drizzle
 * applied it to this very database), but:
 *
 *   1. does the live schema match what `drizzle/` says?
 *   2. does `drizzle-kit generate` produce anything new? (schema drift check)
 *   3. is 0002 purely additive?
 *   4. is the drizzle journal well-formed?
 */
import "dotenv/config";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const out: string[] = [];
const check = (name: string, pass: boolean, detail = ""): void => {
  out.push(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const client = new Client({ connectionString: process.env.DATABASE_URL! });
await client.connect();

// ---- 1. live schema -------------------------------------------------------
const { rows: cols } = await client.query(
  `select table_name, column_name, data_type
   from information_schema.columns
   where table_schema = 'public' and table_name in ('api_keys','provider_health')
   order by table_name, column_name`
);
const keyCols = cols.filter((c: any) => c.table_name === "api_keys");
const healthCols = cols.filter((c: any) => c.table_name === "provider_health");
check("api_keys exists with 10 columns", keyCols.length === 10, `${keyCols.length}`);
check("provider_health exists with 11 columns", healthCols.length === 11, `${healthCols.length}`);
check(
  "timestamp columns are timestamptz",
  cols.filter((c: any) => c.column_name.endsWith("_at")).every((c: any) => c.data_type === "timestamp with time zone")
);
check(
  "key_hash / model_id are text (PostgreSQL types)",
  keyCols.find((c: any) => c.column_name === "key_hash")?.data_type === "text" &&
    healthCols.find((c: any) => c.column_name === "model_id")?.data_type === "text"
);

// ---- 2. indexes + FK ------------------------------------------------------
const { rows: idx } = await client.query(
  `select indexname from pg_indexes
   where schemaname = 'public' and tablename in ('api_keys','provider_health')`
);
const indexNames = idx.map((r: any) => r.indexname);
check("api_keys.key_hash uniquely indexed", indexNames.includes("api_keys_key_hash_unique"));
check("api_keys.user_id indexed", indexNames.includes("api_keys_user_id_idx"));
check(
  "provider_health indexes present",
  ["provider_health_provider_id_idx", "provider_health_status_idx", "provider_health_checked_at_idx"].every((n) =>
    indexNames.includes(n)
  )
);
const { rows: fks } = await client.query(
  `select confdeltype from pg_constraint
   where conrelid = 'public.api_keys'::regclass and contype = 'f'`
);
check("api_keys → users FK is ON DELETE CASCADE", fks[0]?.confdeltype === "c", String(fks[0]?.confdeltype));
await client.end();

// ---- 3. no schema drift ---------------------------------------------------
// The strongest available check: if the Drizzle schema and the migration
// history disagree, `generate` emits a new migration file.
// drizzle-kit writes its result to stderr, so both streams are captured and
// the exit code is ignored on purpose.
const probe = spawnSync("npx", ["drizzle-kit", "generate", "--name=drift_probe"], {
  encoding: "utf8",
  shell: true,
});
const generated = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
const drift = /no schema changes|nothing to migrate|nothing to change/i.test(generated);
check(
  "drizzle schema and migrations are in sync (no drift)",
  drift,
  drift
    ? "generate reports no schema changes"
    : generated.replace(/\s+/g, " ").slice(-160)
);

// ---- 4. migration is additive + journal is well-formed --------------------
const sql0002 = readFileSync("drizzle/0002_bent_genesis.sql", "utf8");
// Destructive DDL only. `ON DELETE CASCADE` is a referential rule, not a
// statement that deletes anything, so the keywords are matched as statements
// (at the start of a statement) rather than anywhere in the text.
const destructive = /(^|;|\n)\s*(DROP|DELETE|TRUNCATE|ALTER\s+COLUMN)\b/i;
check("0002 is purely additive (no destructive statements)", !destructive.test(sql0002));
check(
  "0002's only DELETE is a referential rule (ON DELETE CASCADE)",
  /ON DELETE cascade/i.test(sql0002)
);
check("0002 creates both new tables", /CREATE TABLE "api_keys"/.test(sql0002) && /CREATE TABLE "provider_health"/.test(sql0002));
check("0002 contains no SQLite-specific DDL", !/AUTOINCREMENT|PRAGMA|BLOB/i.test(sql0002));

const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
check("journal lists 0002_bent_genesis", journal.entries.some((e: any) => e.tag === "0002_bent_genesis"));
check("journal indexes are sequential", journal.entries.every((e: any, i: number) => e.idx === i));
check(
  "every journal entry has a matching .sql file",
  journal.entries.every((e: any) => {
    try {
      readFileSync(`drizzle/${e.tag}.sql`);
      return true;
    } catch {
      return false;
    }
  })
);

console.log(out.join("\n"));
const failed = out.filter((r) => r.startsWith("FAIL"));
console.log(`\n${out.length - failed.length}/${out.length} migration checks passed`);
if (failed.length) console.log("FAILED:\n" + failed.join("\n"));
process.exit(failed.length ? 1 : 0);
