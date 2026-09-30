import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit config.
 *
 * MIGRATIONS ONLY — this file never runs application queries.
 *
 * The connection string comes from `DATABASE_URL` and nothing else. There is no
 * fallback URL: a committed default with an embedded password is a real secret
 * in the repository, and it also silently points a developer at the wrong
 * database.
 *
 * `DATABASE_URL` is therefore required for every command. It is only *read* by
 * the commands that connect (`db:migrate`, `db:studio`); `db:generate` and
 * `db:check` diff the schema against the recorded snapshot offline and never
 * open a socket, so any syntactically valid value works for them — including the
 * credential-free `postgresql:///placeholder` shown below, which carries no user
 * and no password and therefore cannot leak or reach anything.
 *
 * Usage:
 *   npm run db:generate   # write migration SQL (offline; URL is not connected to)
 *   npm run db:check      # verify schema and migrations agree (offline)
 *   npm run db:migrate    # apply migrations to DATABASE_URL
 *
 * There is intentionally no `db:push` or reset script in normal development:
 * schema changes go through reviewed, additive migration files.
 */

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  throw new Error(
    "DATABASE_URL is not set.\n" +
      "drizzle-kit never carries its own credentials. Export it before running " +
      "db:generate / db:check / db:migrate, for example:\n" +
      '  $env:DATABASE_URL = "postgresql://USER:PASSWORD@HOST:5432/DBNAME"   # PowerShell\n' +
      '  export DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DBNAME"     # bash/zsh\n' +
      "The value above is a template — substitute your own host and credentials.\n" +
      "For the offline commands (db:generate, db:check) a credential-free " +
      "placeholder such as \"postgresql:///placeholder\" is enough."
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
});
