/**
 * NEXA AI Gateway — API key material.
 *
 * Rules (all enforced here, in one place):
 *
 *  - A key is generated from 32 bytes of CSPRNG entropy and is shown to the
 *    user exactly once. NEXA stores a SHA-256 digest, never the key.
 *  - A server-side pepper (`NEXA_API_KEY_PEPPER`) is mixed in, so a database
 *    leak alone does not let an attacker test candidate keys offline. It is
 *    required in production: hashing refuses to run unpeppered rather than
 *    silently degrading to an unkeyed digest.
 *  - Authentication is `Authorization: Bearer <NEXA_API_KEY>`. A session cookie
 *    is never accepted on the public `/v1/*` surface — those are different
 *    credentials with different lifetimes, and confusing them is how API keys
 *    end up in browser history.
 *  - A raw key never appears in a log, an error message, or a response body.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const NEXA_API_KEY_PREFIX = "nexa_sk_";
/** Characters kept for display: `nexa_sk_` + 8. */
const DISPLAY_LENGTH = NEXA_API_KEY_PREFIX.length + 8;

export interface GeneratedApiKey {
  /** Shown once. Never stored. */
  plaintext: string;
  /** Public id, safe to log and to reference in the database. */
  id: string;
  /** SHA-256 (peppered) digest, hex. */
  hash: string;
  /** `nexa_sk_ab12cd34…` — display only. */
  displayPrefix: string;
}

/**
 * Server-side pepper mixed into every key digest.
 *
 * Absent is tolerated in development, where a throw would make the app
 * unusable on a fresh clone. It is NOT tolerated in production: an empty pepper
 * means `sha256("nexa-gateway:v1::" + key)`, which is a *deterministic, unkeyed*
 * digest. Anyone holding a database dump could then confirm a guessed key
 * offline, and rotating the pepper later would not help keys already exposed
 * that way. Failing loudly at the boundary is strictly safer than silently
 * running in a weaker mode than the operator believes they are in.
 *
 * The thrown message names the variable and never its value, so an operator can
 * act on it without the error becoming a disclosure channel.
 */
export function apiKeyPepper(): string {
  const pepper = (process.env.NEXA_API_KEY_PEPPER ?? "").trim();
  if (!pepper && process.env.NODE_ENV === "production") {
    throw new Error(
      "NEXA_API_KEY_PEPPER is required in production. Generate one with `openssl rand -hex 32`. " +
        "API key hashing is refusing to run unpeppered."
    );
  }
  return pepper;
}

export function hashApiKey(plaintext: string): string {
  const pepper = apiKeyPepper();
  return createHash("sha256")
    .update(`nexa-gateway:v1:${pepper}:${plaintext}`, "utf8")
    .digest("hex");
}

export function displayPrefixOf(plaintext: string): string {
  return `${plaintext.slice(0, DISPLAY_LENGTH)}…`;
}

export function generateApiKey(): GeneratedApiKey {
  const secret = randomBytes(32).toString("base64url");
  const id = randomBytes(8).toString("hex");
  const plaintext = `${NEXA_API_KEY_PREFIX}${id}${secret}`;
  return {
    plaintext,
    id,
    hash: hashApiKey(plaintext),
    displayPrefix: displayPrefixOf(plaintext),
  };
}

/** Does this look like a key NEXA issued? (Cheap format check, not validation.) */
export function isNexaApiKeyFormat(value: string): boolean {
  return value.startsWith(NEXA_API_KEY_PREFIX) && value.length >= 40;
}

/**
 * Read a bearer token from an Authorization header.
 * Only `Bearer` is accepted; nothing is read from a cookie or a query string.
 */
export function extractBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

/** Constant-time comparison for equal-length secrets. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/** Never log a raw key: this is the only projection that may leave the server. */
export function maskApiKey(plaintext: string): string {
  return displayPrefixOf(plaintext);
}
