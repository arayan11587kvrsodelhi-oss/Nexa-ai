import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, passwordResetTokens } from "@/db/schema";
import { PasswordResetTokenService, PASSWORD_RESET_TTL_MS } from "@/lib/auth/tokens";
import {
  PASSWORD_RESET_GENERIC_MESSAGE,
  buildPasswordResetUrl,
  deliverPasswordReset,
  isProduction,
} from "@/lib/auth/password-reset-mail";
import { toErrorResponse, ApiError } from "@/lib/api/errors";
import { AuditLogger } from "@/lib/security/audit";
import { limitRequest, clientIp } from "@/lib/security/rate-limit";
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Best-effort pruning of stale reset rows for one user. Never throws. */
async function cleanupStaleForUser(userId: string): Promise<void> {
  try {
    await db
      .delete(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.userId, userId),
          or(
            lt(passwordResetTokens.expiresAt, new Date()),
            isNotNull(passwordResetTokens.usedAt)
          )
        )
      );
  } catch {
    /* cleanup is opportunistic */
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

    const limit = limitRequest(req, "auth.forgot_password", 5, 60_000);
    if (!limit.allowed) {
      throw ApiError.rateLimited(
        `Too many reset requests. Try again in ${limit.retryAfterSeconds}s.`
      );
    }

    if (!EMAIL_RE.test(email)) {
      throw ApiError.badRequest("Enter a valid email address.");
    }

    const rows = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    const user = rows[0];

    // Unknown account: identical generic response, no user id in audit.
    if (!user) {
      await AuditLogger.log(
        "auth.password_reset_requested",
        { emailDomain: email.split("@")[1] ?? "unknown" },
        clientIp(req),
        "success",
        undefined
      );
      return NextResponse.json({ message: PASSWORD_RESET_GENERIC_MESSAGE });
    }

    // Supersede previous unused tokens so only the newest link works.
    await db
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokens.userId, user.id),
          isNull(passwordResetTokens.usedAt)
        )
      );

    const rawToken = PasswordResetTokenService.create();
    const tokenHash = PasswordResetTokenService.hash(rawToken);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
    await db.insert(passwordResetTokens).values({
      id: newId("prt"),
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    // Opportunistic cleanup (fire-and-forget; never blocks the response).
    void cleanupStaleForUser(user.id).catch(() => undefined);

    await AuditLogger.log(
      "auth.password_reset_requested",
      { userId: user.id },
      clientIp(req),
      "success",
      user.id
    );

    // Production must use a real email provider; never return the URL there.
    if (isProduction()) {
      await deliverPasswordReset(email).catch(() => false);
      return NextResponse.json({ message: PASSWORD_RESET_GENERIC_MESSAGE });
    }

    // DEVELOPMENT ONLY: expose the reset URL so local dev can complete the flow.
    const developmentResetUrl = buildPasswordResetUrl(req, rawToken);
    return NextResponse.json({
      message: PASSWORD_RESET_GENERIC_MESSAGE,
      developmentResetUrl,
    });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}

/**
 * Lightweight cleanup for expired/used reset tokens.
 * Call from a cron/scheduler if one exists; otherwise the routes prune
 * opportunistically per user. Deletes in small batches, never throws.
 */
export async function cleanupExpiredResetTokens(batchLimit = 500): Promise<number> {
  try {
    const stale = await db
      .select({ id: passwordResetTokens.id })
      .from(passwordResetTokens)
      .where(
        or(
          lt(passwordResetTokens.expiresAt, new Date()),
          isNotNull(passwordResetTokens.usedAt)
        )
      )
      .limit(batchLimit);
    let deleted = 0;
    for (const row of stale) {
      await db
        .delete(passwordResetTokens)
        .where(eq(passwordResetTokens.id, row.id));
      deleted += 1;
    }
    return deleted;
  } catch {
    return 0;
  }
}
