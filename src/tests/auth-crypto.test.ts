import { describe, it, expect } from "vitest";
import { PasswordService } from "@/lib/auth/password";
import { SessionTokenService } from "@/lib/auth/tokens";
import { sessionCookieOptions, sessionClearCookieOptions, SESSION_COOKIE } from "@/lib/auth/cookies";

describe("PasswordService", () => {
  it("hashes and verifies a password", async () => {
    const hash = await PasswordService.hash("correct horse battery staple");
    expect(hash).not.toContain("correct");
    expect(hash.startsWith("$2")).toBe(true);
    expect(await PasswordService.verify("correct horse battery staple", hash)).toBe(true);
    expect(await PasswordService.verify("wrong password", hash)).toBe(false);
  });

  it("produces a unique salt per hash", async () => {
    const [a, b] = await Promise.all([
      PasswordService.hash("same-password"),
      PasswordService.hash("same-password"),
    ]);
    expect(a).not.toBe(b);
  });

  it("never throws on a malformed hash", async () => {
    expect(await PasswordService.verify("x", "not-a-bcrypt-hash")).toBe(false);
  });

  it("verifies both hashes of the same password independently", async () => {
    const [a, b] = await Promise.all([
      PasswordService.hash("shared-secret-99"),
      PasswordService.hash("shared-secret-99"),
    ]);
    expect(await PasswordService.verify("shared-secret-99", a)).toBe(true);
    expect(await PasswordService.verify("shared-secret-99", b)).toBe(true);
  });

  it("rejects empty and short password input for hashing", async () => {
    await expect(PasswordService.hash("")).rejects.toThrow();
    await expect(PasswordService.hash("short")).rejects.toThrow();
  });

  it("rejects oversized password input for hashing", async () => {
    await expect(PasswordService.hash("x".repeat(201))).rejects.toThrow();
  });

  it("rejects non-string input without throwing a driver error", async () => {
    // @ts-expect-error intentionally wrong type at the boundary
    await expect(PasswordService.hash(null)).rejects.toThrow();
  });
});

describe("SessionTokenService", () => {
  it("creates 32-byte base64url tokens", () => {
    const t = SessionTokenService.create();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("never repeats tokens", () => {
    const seen = new Set(Array.from({ length: 100 }, () => SessionTokenService.create()));
    expect(seen.size).toBe(100);
  });

  it("hashes deterministically and irreversibly", () => {
    const t = "token-under-test";
    expect(SessionTokenService.hash(t)).toBe(SessionTokenService.hash(t));
    expect(SessionTokenService.hash(t)).not.toContain(t);
    expect(SessionTokenService.hash(t)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("maps distinct tokens to distinct hashes", () => {
    expect(SessionTokenService.hash("a")).not.toBe(SessionTokenService.hash("b"));
  });
});

describe("session cookies", () => {
  it("uses secure attributes", () => {
    const opts = sessionCookieOptions(new Date(Date.now() + 60_000));
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
    expect(opts.path).toBe("/");
    expect(opts.secure).toBe(process.env.NODE_ENV === "production");
  });

  it("clearing cookie is also HttpOnly and expired", () => {
    const opts = sessionClearCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.expires.getTime()).toBe(0);
  });

  it("cookie name is stable", () => {
    expect(SESSION_COOKIE).toBe("nexa_session");
  });
});
