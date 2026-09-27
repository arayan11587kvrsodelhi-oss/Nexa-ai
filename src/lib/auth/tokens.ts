import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * Session tokens.
 *
 * A token is 32 random bytes, base64url-encoded. Only its SHA-256 hash is
 * stored in the `sessions` table, so a database leak does not expose usable
 * credentials. The raw token lives only inside the HttpOnly session cookie.
 */
export const SessionTokenService = {
  create(): string {
    return randomBytes(32).toString("base64url");
  },

  /** Deterministic, irreversible DB key for a token. */
  hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  },
};

/** Short-lived, single-use password reset tokens (30 min expiry). */
export const PASSWORD_RESET_TOKEN_BYTES = 32;
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
export const PASSWORD_RESET_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const PasswordResetTokenService = {
  /** Cryptographically strong opaque token. Never logged or persisted raw. */
  create(): string {
    return randomBytes(PASSWORD_RESET_TOKEN_BYTES).toString("base64url");
  },

  /** SHA-256 hash stored in `password_reset_tokens.token_hash`. */
  hash(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  },

  /** Accepts only tokens this service could have issued (shape check). */
  isPlausible(token: unknown): token is string {
    return typeof token === "string" && PASSWORD_RESET_TOKEN_RE.test(token);
  },

  /**
   * Constant-time comparison of two hex digests.
   * Hashes are deterministic, so lookup is by equality; this helper is for
   * any in-memory comparison path that must not short-circuit on bytes.
   */
  equal(aHex: string, bHex: string): boolean {
    const a = Buffer.from(aHex, "hex");
    const b = Buffer.from(bHex, "hex");
    if (a.length !== b.length || a.length === 0) return false;
    return timingSafeEqual(a, b);
  },
};
