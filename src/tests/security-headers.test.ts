/**
 * Phase 5.1 security regression tests — browser security headers.
 *
 * The policy in `src/lib/security/headers.ts` was derived by inspecting this
 * application (its inline scripts, inline styles, font strategy and network
 * egress), not by copying a generic template. These tests pin the properties
 * that inspection justified, in *both* environments, so a future change cannot
 * quietly relax production.
 *
 * The development policy must be the looser one. If that ever inverts, the
 * production server would be the one shipping `unsafe-eval`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  contentSecurityPolicy,
  generateCspNonce,
  securityHeaders,
} from "@/lib/security/headers";

/** Read one directive out of a CSP string, e.g. `directive(policy, "script-src")`. */
function directive(policy: string, name: string): string {
  const found = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  return found ?? "";
}

/** Convenience view of the header list. */
function headerValue(key: string): string | undefined {
  return securityHeaders().find((h) => h.key === key)?.value;
}

const ORIGINAL_ENV = process.env.NODE_ENV;

afterEach(() => {
  // `vi.stubEnv` is used throughout (NODE_ENV is typed read-only, so it cannot
  // be assigned directly); `unstubAllEnvs` restores the original value.
  vi.unstubAllEnvs();
  if (process.env.NODE_ENV !== ORIGINAL_ENV) {
    vi.stubEnv("NODE_ENV", ORIGINAL_ENV);
  }
});

describe("security headers — production", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
  });

  it("sends a Content-Security-Policy that denies by default", () => {
    // The single rule in next.config.ts applies to /:path*, so this exact
    // string is what every response carries.
    expect(contentSecurityPolicy()).toContain("default-src 'self'");
  });

  it("denies framing through both modern and legacy mechanisms", () => {
    // frame-ancestors is what modern browsers honour; X-Frame-Options is the
    // fallback. Shipping only one leaves older browsers clickjackable.
    expect(contentSecurityPolicy()).toContain("frame-ancestors 'none'");
    expect(headerValue("X-Frame-Options")).toBe("DENY");
  });

  it("allows the browser to reach this origin and nothing else", () => {
    // The highest-value directive in the policy. Even a successful XSS cannot
    // exfiltrate via fetch, XHR, sendBeacon, WebSocket or EventSource.
    expect(directive(contentSecurityPolicy(), "connect-src")).toBe("connect-src 'self'");
  });

  it("never permits a wildcard in any source directive", () => {
    // A bare `*` in any of these silently re-opens the hole the policy closes.
    for (const name of [
      "default-src",
      "script-src",
      "style-src",
      "img-src",
      "font-src",
      "connect-src",
      "worker-src",
    ]) {
      expect(directive(contentSecurityPolicy(), name), name).not.toMatch(/\s\*($|\s)/);
    }
  });

  it("does not permit unsafe-eval", () => {
    // Nothing in NEXA evaluates strings; the calculator is a hand-written
    // parser specifically so this can stay true. A regression means some
    // component started using eval or new Function.
    expect(contentSecurityPolicy()).not.toContain("unsafe-eval");
  });

  it("does not grant plugins, base-tag rewriting, or offsite form posts", () => {
    const policy = contentSecurityPolicy();
    expect(directive(policy, "object-src")).toBe("object-src 'none'");
    expect(directive(policy, "base-uri")).toBe("base-uri 'self'");
    expect(directive(policy, "form-action")).toBe("form-action 'self'");
  });

  it("keeps images same-origin, contacting no third-party host", () => {
    // Fonts are self-hosted by next/font and there is no <img> or next/image in
    // the app, so no CDN host should ever appear in this directive.
    const img = directive(contentSecurityPolicy(), "img-src");
    expect(img).toContain("'self'");
    expect(img).not.toMatch(/https?:\/\//);
  });

  it("sends nosniff, a referrer policy and a permissions policy", () => {
    expect(headerValue("X-Content-Type-Options")).toBe("nosniff");
    // no-referrer, because a referrer would otherwise carry conversation ids
    // and password-reset tokens in its path.
    expect(headerValue("Referrer-Policy")).toBe("no-referrer");
    const permissions = headerValue("Permissions-Policy") ?? "";
    expect(permissions).toContain("camera=()");
    expect(permissions).toContain("microphone=()");
    expect(permissions).toContain("geolocation=()");
  });

  it("disables the legacy XSS auditor rather than enabling it", () => {
    // The old filter was itself a source of vulnerabilities. `0` is the modern
    // correct value; a `1` here would be a genuine regression.
    expect(headerValue("X-XSS-Protection")).toBe("0");
  });

  it("sends HSTS and forces https for subresources", () => {
    expect(headerValue("Strict-Transport-Security")).toMatch(/max-age=\d+/);
    expect(contentSecurityPolicy()).toContain("upgrade-insecure-requests");
  });

  it("scopes HSTS to the apex domain rather than sibling hosts", () => {
    // includeSubDomains / preload would reach hosts this app does not own.
    const hsts = headerValue("Strict-Transport-Security") ?? "";
    expect(hsts).not.toContain("includeSubDomains");
    expect(hsts).not.toContain("preload");
  });

  it("declares no header twice", () => {
    // A duplicate key would silently take one value and hide the other.
    const keys = securityHeaders().map((h) => h.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("security headers — production CSP nonce (Phase 5.5)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
  });

  it("removes unsafe-inline from script-src when a nonce is supplied", () => {
    // The whole point of the change: with a nonce, `'unsafe-inline'` is not
    // merely unnecessary — browsers ignore it for script-src anyway. The
    // assertion is scoped to script-src because `style-src` still legitimately
    // needs it for React's inline style attributes.
    const policy = contentSecurityPolicy("abc123");
    expect(directive(policy, "script-src")).toBe("script-src 'self' 'nonce-abc123'");
    expect(directive(policy, "script-src")).not.toContain("unsafe-inline");
  });

  it("keeps every other production directive identical to the non-nonce policy", () => {
    const withNonce = contentSecurityPolicy("abc123");
    const without = contentSecurityPolicy();
    for (const name of [
      "default-src",
      "style-src",
      "img-src",
      "font-src",
      "connect-src",
      "object-src",
      "base-uri",
      "form-action",
      "frame-ancestors",
      "manifest-src",
      "worker-src",
    ]) {
      expect(directive(withNonce, name), name).toBe(directive(without, name));
    }
  });

  it("still never permits unsafe-eval in production", () => {
    expect(contentSecurityPolicy("abc123")).not.toContain("unsafe-eval");
  });

  it("never permits a wildcard even with a nonce", () => {
    for (const name of ["script-src", "style-src", "connect-src", "default-src"]) {
      expect(directive(contentSecurityPolicy("abc123"), name), name).not.toMatch(/\s\*($|\s)/);
    }
  });

  it("falls back to the inline-permitting policy when no nonce is available", () => {
    // A non-document response gets no nonce; emitting a nonce-only script-src
    // there would be a header that permits nothing, so the safe fallback is used.
    expect(directive(contentSecurityPolicy(), "script-src")).toBe(
      "script-src 'self' 'unsafe-inline'"
    );
  });

  it("generates a distinct, high-entropy nonce per call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) seen.add(generateCspNonce());
    // A reused nonce would let an injected script from one response run in
    // another, so uniqueness is the property that matters.
    expect(seen.size).toBe(50);
    for (const nonce of seen) {
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe("security headers — development", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
  });

  it("permits eval for React Fast Refresh", () => {
    expect(contentSecurityPolicy()).toContain("'unsafe-eval'");
  });

  it("allows the HMR websocket", () => {
    expect(directive(contentSecurityPolicy(), "connect-src")).toContain("ws:");
  });

  it("does not send HSTS over plain http", () => {
    // Sent during local development it can make a browser refuse to load
    // http://localhost at all, which looks like an unrelated breakage.
    expect(headerValue("Strict-Transport-Security")).toBeUndefined();
    expect(contentSecurityPolicy()).not.toContain("upgrade-insecure-requests");
  });

  it("keeps every production-relevant directive identical", () => {
    // Development is looser only where the toolchain demands it. Everything
    // that protects a deployed app must read the same in both environments.
    vi.stubEnv("NODE_ENV", "production");
    const prod = contentSecurityPolicy();
    vi.stubEnv("NODE_ENV", "development");
    const dev = contentSecurityPolicy();
    for (const name of [
      "default-src",
      "object-src",
      "base-uri",
      "form-action",
      "frame-ancestors",
      "img-src",
      "font-src",
      "style-src",
    ]) {
      expect(directive(dev, name), name).toBe(directive(prod, name));
    }
  });
});
