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
    /**
     * Phase 6: the default 5s budget is too tight for the deliberately slow
     * parts of this suite — password hashing is intentionally expensive, and
     * under full-suite parallel load a `hash and verify` test was tripping the
     * 5s ceiling intermittently (observed once in two consecutive full runs,
     * and passing every time in isolation).
     *
     * This raises the *ceiling* only. It cannot mask a real failure: a failing
     * assertion still fails immediately, and a genuinely hung test now waits
     * longer before reporting. 20s clears the hashing path with headroom
     * without turning a hang into a long stall.
     */
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
