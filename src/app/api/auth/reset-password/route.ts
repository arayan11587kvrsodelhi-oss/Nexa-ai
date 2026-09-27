import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, passwordResetTokens } from "@/db/schema";
import { PasswordService } from "@/lib/auth/password";
import { SessionService } from "@/lib/auth/session";
import { PasswordResetTokenService } from "@/lib/auth/tokens";
import { toErrorResponse, ApiError } from "@/lib/api/errors";
import { AuditLogger } from "@/lib/security/audit";
import { limitRequest, clientIp } from "@/lib/security/rate-limit";
import { and, eq, isNull } from "drizzle-orm";

export const dynamic = "force-dynamic";

export const INVALID_RESET_LINK_MESSAGE =
  "That password reset link is invalid or has expired. Please request a new one.";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const token = typeof body.token === "string" ? body.token : "";
    const password = typeof body.password === "string" ? body.password : "";

    const limit = limitRequest(req, "auth.reset_password", 10, 60_000);
    if (!limit.allowed) {
      throw ApiError.rateLimited(
        `Too many reset attempts. Try again in ${limit.retryAfterSeconds}s.`
      );
    }

    if (!token) {
      await AuditLogger.log("auth.password_reset_failed", { reason: "missing_token" }, clientIp(req), "warning", undefined);
      throw ApiError.badRequest(INVALID_RESET_LINK_MESSAGE);
    }
    try {
      PasswordService.assertAcceptable(password);
    } catch {
      await AuditLogger.log("auth.password_reset_failed", { reason: "weak_password" }, clientIp(req), "warning", undefined);
      throw ApiError.badRequest("Password must be 8 to 200 characters.");
    }

    if (!PasswordResetTokenService.isPlausible(token)) {
      await AuditLogger.log("auth.password_reset_failed", { reason: "invalid_token" }, clientIp(req), "warning", undefined);
      throw ApiError.badRequest(INVALID_RESET_LINK_MESSAGE);
    }

    const tokenHash = PasswordResetTokenService.hash(token);
    const rows = await db
      .select({
        id: passwordResetTokens.id,
        userId: passwordResetTokens.userId,
        expiresAt: passwordResetTokens.expiresAt,
        usedAt: passwordResetTokens.usedAt,
      })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash))
      .limit(1);
    const reset = rows[0];

    if (!reset || reset.usedAt || reset.expiresAt.getTime() <= Date.now()) {
      await AuditLogger.log("auth.password_reset_failed", { reason: "invalid_token" }, clientIp(req), "warning", undefined);
      throw ApiError.badRequest(INVALID_RESET_LINK_MESSAGE);
    }

    const userRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, reset.userId))
      .limit(1);
    const user = userRows[0];
    if (!user) {
      await AuditLogger.log("auth.password_reset_failed", { reason: "invalid_token" }, clientIp(req), "warning", undefined);
      throw ApiError.badRequest(INVALID_RESET_LINK_MESSAGE);
    }

    const passwordHash = await PasswordService.hash(password);

    const consumed = await db
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResetTokens.id, reset.id), isNull(passwordResetTokens.usedAt)))
      .returning({ id: passwordResetTokens.id });
    if (consumed.length === 0) {
      await AuditLogger.log("auth.password_reset_failed", { reason: "invalid_token" }, clientIp(req), "warning", user.id);
      throw ApiError.badRequest(INVALID_RESET_LINK_MESSAGE);
    }

    await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, user.id));

    await SessionService.destroyAllUserSessions(user.id);

    await AuditLogger.log("auth.password_reset_completed", { userId: user.id }, clientIp(req), "success", user.id);

    return NextResponse.json({
      message: "Your password has been reset. Please sign in with your new password.",
    });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}
