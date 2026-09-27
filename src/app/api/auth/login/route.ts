import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { PasswordService } from "@/lib/auth/password";
import { SessionService } from "@/lib/auth/session";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/cookies";
import { toErrorResponse, ApiError } from "@/lib/api/errors";
import { AuditLogger } from "@/lib/security/audit";
import { limitRequest } from "@/lib/security/rate-limit";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!email || !password) {
      throw ApiError.badRequest("Email and password are required.");
    }
    const limit = limitRequest(req, "auth.login", 10, 60_000);
    if (!limit.allowed) {
      throw ApiError.rateLimited(`Too many login attempts. Try again in ${limit.retryAfterSeconds}s.`);
    }

    const rows = await db
      .select({ id: users.id, email: users.email, name: users.name, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    const user = rows[0];
    // Same generic message for unknown email and wrong password: never reveal
    // which one failed.
    if (!user || !(await PasswordService.verify(password, user.passwordHash))) {
      await AuditLogger.log("auth.login_failed", { email });
      throw ApiError.unauthorized("Incorrect email or password.");
    }

    const { token, expiresAt } = await SessionService.createSession(user.id);
    await AuditLogger.log("auth.login", { userId: user.id });

    const res = NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name },
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
    return res;
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}
