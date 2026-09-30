/**
 * Phase 7.1 — the test-database safety guard.
 *
 * The property under test is that no automated test can reach the operator's
 * configured database by accident. The cases below are the exact shapes that
 * would be catastrophic: a managed production URL, a non-loopback host with no
 * opt-in, and a missing configuration.
 *
 * The credentials here are syntactically realistic but meaningless. This file
 * never opens a connection.
 */
import { describe, it, expect } from "vitest";
import {
  classifyDatabaseUrl,
  resolveTestDatabase,
  assertTestDatabaseUsable,
} from "@/lib/testing/test-database";

/** Loopback test database. */
const LOCAL = "postgresql://tester:nosuchpassword@127.0.0.1:5432/nexa_test";
const PROD = "postgresql://u:p@ep-x.us-east-2.aws.neon.tech/prod";

describe("classifyDatabaseUrl", () => {
  it("recognises loopback hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "127.0.0.5", "[::1]"]) {
      const t = classifyDatabaseUrl(`postgresql://u:p@${host}:5432/nexa_test`);
      expect(t, host).not.toBeNull();
      expect(t!.isLoopback, host).toBe(true);
    }
  });

  it("extracts host, port and database name", () => {
    const t = classifyDatabaseUrl(LOCAL)!;
    expect(t.host).toBe("127.0.0.1");
    expect(t.port).toBe("5432");
    expect(t.database).toBe("nexa_test");
  });

  it("never leaks the username or password", () => {
    const json = JSON.stringify(classifyDatabaseUrl(LOCAL)!);
    expect(json).not.toContain("tester");
    expect(json).not.toContain("nosuchpassword");
  });

  it("flags managed production hosts", () => {
    for (const host of [
      "ep-cool-name.us-east-2.aws.neon.tech",
      "db.abc.supabase.co",
      "prod.abc.rds.amazonaws.com",
    ]) {
      expect(classifyDatabaseUrl(`postgresql://u:p@${host}/db`)!.looksLikeProduction, host).toBe(
        true
      );
    }
  });

  it("returns null for unparseable or non-postgres URLs", () => {
    for (const bad of ["", "not a url", "https://example.com", "mysql://u@h/db", undefined]) {
      expect(classifyDatabaseUrl(bad as string), String(bad)).toBeNull();
    }
  });
});

describe("resolveTestDatabase refuses unsafe targets", () => {
  it("refuses when no test database is configured", () => {
    const r = resolveTestDatabase({});
    expect(r.usable).toBe(false);
    expect(r.reason).toMatch(/NEXA_TEST_DATABASE_URL/);
  });

  it("NEVER falls back to DATABASE_URL", () => {
    // The whole point: a configured production DATABASE_URL must not become
    // the test target just because no test URL was set.
    const r = resolveTestDatabase({ DATABASE_URL: PROD });
    expect(r.usable).toBe(false);
    expect(r.target).toBeNull();
  });

  it("refuses a managed production URL even when explicitly configured", () => {
    const r = resolveTestDatabase({ NEXA_TEST_DATABASE_URL: PROD });
    expect(r.usable).toBe(false);
    expect(r.reason).toMatch(/production instance/i);
  });

  it("refuses a non-loopback host without the documented opt-in", () => {
    const r = resolveTestDatabase({
      NEXA_TEST_DATABASE_URL: "postgresql://u:p@10.0.0.5:5432/nexa_test",
    });
    expect(r.usable).toBe(false);
    expect(r.reason).toMatch(/not loopback/i);
  });

  it("refuses a production host even WITH the opt-in", () => {
    const r = resolveTestDatabase({
      NEXA_TEST_DATABASE_URL: PROD,
      NEXA_ALLOW_REMOTE_TEST_DATABASE: "true",
    });
    expect(r.usable).toBe(false);
  });

  it("refuses a malformed URL", () => {
    const r = resolveTestDatabase({ NEXA_TEST_DATABASE_URL: "nonsense" });
    expect(r.usable).toBe(false);
    expect(r.reason).toMatch(/not a valid/i);
  });
});

describe("resolveTestDatabase accepts a safe target", () => {
  it("accepts a loopback test database", () => {
    const r = resolveTestDatabase({ NEXA_TEST_DATABASE_URL: LOCAL });
    expect(r.usable).toBe(true);
    expect(r.target?.database).toBe("nexa_test");
  });

  it("accepts the TEST_DATABASE_URL alias", () => {
    expect(resolveTestDatabase({ TEST_DATABASE_URL: LOCAL }).usable).toBe(true);
  });

  it("prefers NEXA_TEST_DATABASE_URL over the alias", () => {
    const r = resolveTestDatabase({
      NEXA_TEST_DATABASE_URL: LOCAL,
      TEST_DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/other",
    });
    expect(r.target?.database).toBe("nexa_test");
  });

  it("accepts a remote host only with the documented opt-in", () => {
    const r = resolveTestDatabase({
      NEXA_TEST_DATABASE_URL: "postgresql://u:p@10.0.0.5:5432/scratch",
      NEXA_ALLOW_REMOTE_TEST_DATABASE: "true",
    });
    expect(r.usable).toBe(true);
  });

  it("keeps the reason free of credentials", () => {
    const r = resolveTestDatabase({ NEXA_TEST_DATABASE_URL: LOCAL });
    expect(r.reason).not.toContain("nosuchpassword");
    expect(r.reason).not.toContain("tester");
  });
});

describe("assertTestDatabaseUsable is the integration runner gate", () => {
  it("throws instead of running when no test database exists", () => {
    expect(() => assertTestDatabaseUsable({})).toThrow(/aborted/i);
  });

  it("throws rather than falling back to DATABASE_URL", () => {
    expect(() => assertTestDatabaseUsable({ DATABASE_URL: PROD })).toThrow(/aborted/i);
  });

  it("returns the target when a safe test database is configured", () => {
    expect(assertTestDatabaseUsable({ NEXA_TEST_DATABASE_URL: LOCAL }).database).toBe(
      "nexa_test"
    );
  });

  it("never includes credentials in the abort message", () => {
    try {
      assertTestDatabaseUsable({
        NEXA_TEST_DATABASE_URL: "postgresql://tester:nosuchpassword@10.0.0.5/scratch",
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain("nosuchpassword");
      expect((e as Error).message).not.toContain("tester");
    }
  });
});
