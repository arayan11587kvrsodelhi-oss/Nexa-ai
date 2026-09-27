import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit config.
 *
 * MIGRATIONS ONLY — this file never runs application queries.
 *
 * The URL is read from DATABASE_URL so real credentials never live in a
 * committed file. Generate SQL with `npm run db:generate`; apply it with
 * `npm run db:migrate`. There is intentionally no `db:push` or reset script in
 * normal development: schema changes go through reviewed, additive migration
 * files.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:5432/nexa_ai",
  },
});
