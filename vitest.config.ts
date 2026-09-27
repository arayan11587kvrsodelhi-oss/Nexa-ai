import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Test configuration for NEXA Phase 16/4 verification.
 *
 * Two test tiers:
 *  1. Pure unit tests (auth crypto, ownership query builders) — always runnable.
 *  2. Live PostgreSQL integration tests (src/tests/integration/*.live.ts) —
 *     only run when DATABASE_URL points at a reachable database. Otherwise
 *     they skip and are reported as "live DB verification NOT RUN".
 */
export default defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts", "src/tests/**/*.live.ts"],
    globals: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
