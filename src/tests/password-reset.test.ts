import "dotenv/config";
import { describe, it, expect, vi } from "vitest";
import { NextRequest as NextRequestClass } from "next/server";
import { PasswordResetTokenService, PASSWORD_RESET_TTL_MS } from "@/lib/auth/tokens";
import { PasswordService } from "@/lib/auth/password";
import { resolveTestDatabase } from "@/lib/testing/test-database";

/**
 * Phase 7.1 — this file must never write to the operator's database.
 *
 * Line 1 loads `.env` into `process.env`, so `DATABASE_URL` — the configured,
 * and in a real deployment *production*, database — is present on every
 * `npm test`. The "live DB round trip" block below inserts real users and real
 * reset tokens and previously gated only on `if (!DATABASE_URL)`, so it ran
 * against production data on every normal test run.
 *
 * The rule is now: a test may only touch a database explicitly designated by
 * `NEXA_TEST_DATABASE_URL` / `TEST_DATABASE_URL`, and only if the guard agrees
 * it is a safe, disposable target. There is no fallback to `DATABASE_URL`.
 * Without one, the live block skips and says why.
 *
 * This runs before `@/db` is imported, because the connection pool is built
 * lazily on first use and caches the URL it first saw.
 */
const TEST_DB = resolveTestDatabase();
if (TEST_DB.usable) {
  process.env.DATABASE_URL =
    process.env.NEXA_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
}
/** True only when a safe, explicitly-designated test database is available. */
const LIVE_DB = TEST_DB.usable;

describe("reset tokens", () => {
  it("creates unique opaque tokens", () => {
    const seen = new Set(Array.from({ length: 50 }, () => PasswordResetTokenService.create()));
    expect(seen.size).toBe(50);
    for (const t of seen) expect(PasswordResetTokenService.isPlausible(t)).toBe(true);
  });
  it("hashes without exposing raw", () => {
    const raw = PasswordResetTokenService.create();
    const h = PasswordResetTokenService.hash(raw);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(h).not.toContain(raw);
  });
  it("rejects malformed tokens", () => {
    expect(PasswordResetTokenService.isPlausible("")).toBe(false);
    expect(PasswordResetTokenService.isPlausible("short")).toBe(false);
    expect(PasswordResetTokenService.isPlausible(null)).toBe(false);
  });
  it("compares digests safely", () => {
    const h = PasswordResetTokenService.hash(PasswordResetTokenService.create());
    expect(PasswordResetTokenService.equal(h, h)).toBe(true);
    expect(PasswordResetTokenService.equal(h, "0".repeat(64))).toBe(false);
  });
});

describe("password bounds", () => {
  it("rejects below 8 and above 200", () => {
    expect(() => PasswordService.assertAcceptable("x".repeat(7))).toThrow();
    expect(() => PasswordService.assertAcceptable("x".repeat(201))).toThrow();
    expect(() => PasswordService.assertAcceptable("x".repeat(8))).not.toThrow();
    expect(() => PasswordService.assertAcceptable("x".repeat(200))).not.toThrow();
  });
});

describe("mail abstraction", () => {
  it("generic message hides account existence", async () => {
    const { PASSWORD_RESET_GENERIC_MESSAGE, isSafeResetPath, extractRawTokenFromUrl, isResetRowDisposable } =
      await import("@/lib/auth/password-reset-mail");
    expect(PASSWORD_RESET_GENERIC_MESSAGE).toMatch(/If an account exists/);
    expect(isSafeResetPath("/reset-password?token=abc")).toBe(true);
    expect(isSafeResetPath("https://evil.example/reset-password?token=abc")).toBe(false);
    const raw = PasswordResetTokenService.create();
    expect(extractRawTokenFromUrl(`/reset-password?token=${raw}`)).toBe(raw);
    expect(extractRawTokenFromUrl("/reset-password?token=short")).toBeNull();
    expect(isResetRowDisposable({ usedAt: new Date(), expiresAt: new Date(Date.now() + 9999) })).toBe(true);
    expect(isResetRowDisposable({ usedAt: null, expiresAt: new Date(Date.now() - 1) })).toBe(true);
    expect(isResetRowDisposable({ usedAt: null, expiresAt: new Date(Date.now() + 9999) })).toBe(false);
    expect(PASSWORD_RESET_TTL_MS).toBeLessThanOrEqual(30 * 60 * 1000);
    expect(PASSWORD_RESET_TTL_MS).toBeGreaterThanOrEqual(15 * 60 * 1000);
  });
  it("production never returns dev URL and failures leak nothing", async () => {
    const env = process.env as Record<string, string | undefined>;
    const OLD = env["NODE_ENV"];
    const g = globalThis as { __prodN?: number };
    g.__prodN = (g.__prodN ?? 0) + 1;
    env["NODE_ENV"] = "production";
    try {
      const { db } = await import("@/db");
      const { users, passwordResetTokens } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      const tag = `${Date.now()}_p${g.__prodN}`;
      const email = `prod-${tag}@example.com`;
      const userId = `usr_prod_${tag}`;
      await db.insert(users).values({ id: userId, email, name: null, passwordHash: await PasswordService.hash("old-password-123") });
      const { POST: forgot } = await import("@/app/api/auth/forgot-password/route");
      const res = await forgot(new NextRequestClass("http://localhost/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `prod-${tag}` },
        body: JSON.stringify({ email }),
      }));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.message).toMatch(/If an account exists/);
      expect("developmentResetUrl" in data).toBe(false);
      const unk = await forgot(new NextRequestClass("http://localhost/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `prod-u-${tag}` },
        body: JSON.stringify({ email: `nobody-${tag}@example.com` }),
      }));
      const unkData = await unk.json();
      expect(unk.status).toBe(200);
      expect(unkData.message).toBe(data.message);
      expect("developmentResetUrl" in unkData).toBe(false);
      const { POST: reset } = await import("@/app/api/auth/reset-password/route");
      const rawBad = PasswordResetTokenService.create();
      const bad = await reset(new NextRequestClass("http://localhost/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `prod-r-${tag}` },
        body: JSON.stringify({ token: rawBad, password: "brand-new-password-1" }),
      }));
      const badData = await bad.json();
      expect(bad.status).toBe(400);
      expect(JSON.stringify(badData)).not.toMatch(/usr_prod_|@example|token_hash/i);
      expect(JSON.stringify(badData)).not.toContain(rawBad);
      expect(Object.keys(badData).join(",")).not.toMatch(/token/i);
      const { limitRequest } = await import("@/lib/security/rate-limit");
      const mkReq = (ip: string) => new NextRequestClass("http://localhost/api/auth/forgot-password", { method: "POST", headers: { "x-forwarded-for": ip } });
      let blocked = false;
      for (let i = 0; i < 8; i++) {
        const r = limitRequest(mkReq(`rl-${tag}`), "auth.forgot_password", 5, 60_000);
        if (!r.allowed) blocked = true;
      }
      expect(blocked).toBe(true);
      await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    } finally {
      env["NODE_ENV"] = OLD;
    }
  });
});

describe("live DB round trip", () => {
  it("forgot then reset then reuse fails", async () => {
    if (!LIVE_DB) return;
    const { db } = await import("@/db");
    const { users, passwordResetTokens } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const env = process.env as Record<string, string | undefined>;
    const OLD_ENV = env["NODE_ENV"];
    const g = globalThis as { __resetTestN?: number };
    g.__resetTestN = (g.__resetTestN ?? 0) + 1;
    env["NODE_ENV"] = "development";
    const tag = `${Date.now()}_${g.__resetTestN}`;
    try {
      const email = `reset-test-${tag}@example.com`;
      const userId = `usr_reset_${tag}`;
      const oldHash = await PasswordService.hash("old-password-123");
      await db.insert(users).values({ id: userId, email, name: null, passwordHash: oldHash });
      const { POST: forgot } = await import("@/app/api/auth/forgot-password/route");
      const res = await forgot(new NextRequestClass("http://localhost/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `fp-${tag}` },
        body: JSON.stringify({ email }),
      }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.message).toMatch(/If an account exists/);
      const raw = new URL(data.developmentResetUrl).searchParams.get("token") ?? "";
      expect(raw.length).toBeGreaterThan(20);
      const stored = await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
      expect(stored.length).toBe(1);
      expect(stored[0].tokenHash).not.toContain(raw);
      const { POST: reset } = await import("@/app/api/auth/reset-password/route");
      const mk = (token: string, password: string, ip: string) =>
        new NextRequestClass("http://localhost/api/auth/reset-password", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ token, password }),
        });
      expect((await reset(mk(raw, "brand-new-password-1", `rp-a-${tag}`))).status).toBe(200);
      expect((await reset(mk(raw, "another-password-2", `rp-b-${tag}`))).status).toBe(400);
      const bad7 = await reset(mk(PasswordResetTokenService.create(), "short1", `rp-c-${tag}`));
      expect(bad7.status).toBe(400);
      // Sessions invalidated: login with the new password creates a session,
      // a second reset then wipes it.
      const { POST: login } = await import("@/app/api/auth/login/route");
      const loginRes = await login(new NextRequestClass("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `lg-${tag}` },
        body: JSON.stringify({ email, password: "brand-new-password-1" }),
      }));
      expect(loginRes.status).toBe(200);
      const res2 = await forgot(new NextRequestClass("http://localhost/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `fp2-${tag}` },
        body: JSON.stringify({ email }),
      }));
      const data2 = await res2.json();
      const raw2 = new URL(data2.developmentResetUrl).searchParams.get("token") ?? "";
      expect((await reset(mk(raw2, "third-password-333", `rp-e-${tag}`))).status).toBe(200);
      const { sessions } = await import("@/db/schema");
      const sessRows = await db.select().from(sessions).where(eq(sessions.userId, userId));
      expect(sessRows.length).toBe(0);
      await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    } finally {
      (process.env as Record<string, string | undefined>)["NODE_ENV"] = OLD_ENV;
    }
  });
  it("unknown email gets identical generic response (no enumeration)", async () => {
    const { POST: forgot } = await import("@/app/api/auth/forgot-password/route");
    const OLD_ENV = (process.env as Record<string, string | undefined>)["NODE_ENV"];
    (process.env as Record<string, string | undefined>)["NODE_ENV"] = "test";
    try {
      const tag = `enum-${Date.now()}`;
      const mk = (email: string) =>
        new NextRequestClass("http://localhost/api/auth/forgot-password", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `en-${tag}` },
          body: JSON.stringify({ email }),
        });
      const known = await forgot(mk(`reset-test-nonexistent-should-not-exist@example.com`));
      expect(known.status).toBe(200);
      const body = await known.json();
      expect(body.message).toMatch(/If an account exists/);
      expect("developmentResetUrl" in body).toBe(false);
    } finally {
      (process.env as Record<string, string | undefined>)["NODE_ENV"] = OLD_ENV;
    }
  });
  it("expired token cannot reset", async () => {
    if (!LIVE_DB) return;
    const { db } = await import("@/db");
    const { users, passwordResetTokens } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { PasswordResetTokenService: S } = await import("@/lib/auth/tokens");
    const tag = `exp-${Date.now()}`;
    const userId = `usr_exp_${tag}`;
    await db.insert(users).values({
      id: userId,
      email: `exp-${tag}@example.com`,
      name: null,
      passwordHash: await PasswordService.hash("old-password-123"),
    });
    try {
      const raw = S.create();
      await db.insert(passwordResetTokens).values({
        id: `prt_${tag}`,
        userId,
        tokenHash: S.hash(raw),
        expiresAt: new Date(Date.now() - 1000),
      });
      const { POST: reset } = await import("@/app/api/auth/reset-password/route");
      const res = await reset(
        new NextRequestClass("http://localhost/api/auth/reset-password", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `ex-${tag}` },
          body: JSON.stringify({ token: raw, password: "brand-new-password-1" }),
        })
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/invalid or has expired/);
    } finally {
      await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
  });
});