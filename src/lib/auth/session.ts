import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { SessionTokenService } from "./tokens";
import { SESSION_TTL_MS } from "./cookies";
import { eq, lt, and } from "drizzle-orm";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

/**
 * The only place session rows are created, read, and destroyed.
 *
 * Callers receive the raw token exactly once (login / signup) to write into
 * the cookie. Every later lookup goes through the hashed token.
 */
export const SessionService = {
  async createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = SessionTokenService.create();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.insert(sessions).values({
      id: SessionTokenService.hash(token),
      userId,
      expiresAt,
    });
    // Opportunistic cleanup of this user's expired sessions.
    await db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, new Date())));
    return { token, expiresAt };
  },

  /** Resolve the current user from a raw cookie token, or null. */
  async getUserByToken(token: string | undefined | null): Promise<SessionUser | null> {
    if (!token) return null;
    const hashed = SessionTokenService.hash(token);
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, hashed))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.destroySession(token);
      return null;
    }
    return { id: row.id, email: row.email, name: row.name };
  },

  /** Delete one session row by raw token. Safe to call on logout or expiry. */
  async destroySession(token: string | undefined | null): Promise<void> {
    if (!token) return;
    await db.delete(sessions).where(eq(sessions.id, SessionTokenService.hash(token)));
  },

  /**
   * Invalidate every session for a user (password reset / compromise).
   * Also prunes already-expired reset bookkeeping opportunistically.
   */
  async destroyAllUserSessions(userId: string): Promise<void> {
    await db.delete(sessions).where(eq(sessions.userId, userId));
  },
};
