/**
 * NEXA AI Gateway — API key store.
 *
 * Persistence for the public `/v1/*` credentials. Only digests are stored; the
 * plaintext is returned once, at creation.
 *
 * `authenticate` is the hot path (one query), and `touch` is throttled in
 * memory so a busy key does not turn every request into a write.
 */
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { generateApiKey, hashApiKey, isNexaApiKeyFormat } from "./api-keys";

export interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  requestCount: number;
}

export interface AuthenticatedApiKey {
  keyId: string;
  userId: string;
}

/** How often `lastUsedAt` may be rewritten for one key. */
const TOUCH_INTERVAL_MS = 60_000;
const lastTouched = new Map<string, number>();

function toSummary(row: typeof apiKeys.$inferSelect): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    createdAt: (row.createdAt instanceof Date ? row.createdAt : new Date()).toISOString(),
    lastUsedAt: row.lastUsedAt
      ? (row.lastUsedAt instanceof Date ? row.lastUsedAt : new Date(row.lastUsedAt)).toISOString()
      : null,
    revokedAt: row.revokedAt
      ? (row.revokedAt instanceof Date ? row.revokedAt : new Date(row.revokedAt)).toISOString()
      : null,
    expiresAt: row.expiresAt
      ? (row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt)).toISOString()
      : null,
    requestCount: row.requestCount,
  };
}

export const ApiKeyService = {
  /** Create a key for a user. The plaintext is returned exactly once. */
  async create(
    userId: string,
    name?: string,
    options: { expiresInDays?: number } = {}
  ): Promise<{ plaintext: string; summary: ApiKeySummary }> {
    const generated = generateApiKey();
    const expiresAt = options.expiresInDays
      ? new Date(Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const [row] = await db
      .insert(apiKeys)
      .values({
        id: generated.id,
        userId,
        name: name?.trim() || "NEXA API key",
        keyHash: generated.hash,
        keyPrefix: generated.displayPrefix,
        expiresAt,
      })
      .returning();

    return { plaintext: generated.plaintext, summary: toSummary(row) };
  },

  async list(userId: string): Promise<ApiKeySummary[]> {
    const rows = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId))
      .orderBy(desc(apiKeys.createdAt));
    return rows.map(toSummary);
  },

  /** Revoke one of this user's keys. Returns false when not found/owned. */
  async revoke(userId: string, id: string): Promise<boolean> {
    const rows = await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt))
      )
      .returning({ id: apiKeys.id });
    return rows.length > 0;
  },

  /**
   * Resolve a raw key to its owner.
   *
   * Lookup is by digest (unique index), and the digest is compared in constant
   * time as a second check. Revoked and expired keys are rejected.
   */
  async authenticate(plaintext: string): Promise<AuthenticatedApiKey | null> {
    if (!isNexaApiKeyFormat(plaintext)) return null;
    const digest = hashApiKey(plaintext);
    const rows = await db
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        keyHash: apiKeys.keyHash,
        revokedAt: apiKeys.revokedAt,
        expiresAt: apiKeys.expiresAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, digest))
      .limit(1);

    const row = rows[0];
    if (!row || row.keyHash !== digest) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return null;
    return { keyId: row.id, userId: row.userId };
  },

  /** Best-effort usage accounting; never blocks or fails a request. */
  async touch(keyId: string): Promise<void> {
    const now = Date.now();
    const previous = lastTouched.get(keyId) ?? 0;
    if (now - previous < TOUCH_INTERVAL_MS) return;
    lastTouched.set(keyId, now);
    try {
      await db
        .update(apiKeys)
        .set({ lastUsedAt: new Date(), requestCount: sql`${apiKeys.requestCount} + 1` })
        .where(eq(apiKeys.id, keyId));
    } catch {
      // Usage accounting is not worth failing a request over.
      lastTouched.delete(keyId);
    }
  },
};
