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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : null;

    const limit = limitRequest(req, "auth.signup", 5, 60_000);
    if (!limit.allowed) {
      throw ApiError.rateLimited(`Too many signup attempts. Try again in ${limit.retryAfterSeconds}s.`);
    }
    if (!EMAIL_RE.test(email)) {
      throw ApiError.badRequest("Enter a valid email address.");
    }
    if (password.length < 8) {
      throw ApiError.badRequest("Password must be at least 8 characters.");
    }

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing.length > 0) {
      // Do not reveal that the account exists beyond what signup implies.
      throw ApiError.badRequest("An account with that email already exists.");
    }

    const id = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const passwordHash = await PasswordService.hash(password);
    await db.insert(users).values({ id, email, name, passwordHash });

    const { token, expiresAt } = await SessionService.createSession(id);
    await AuditLogger.log("auth.signup", { userId: id });

    const res = NextResponse.json(
      { user: { id, email, name } },
      { status: 201 }
    );
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
    return res;
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}
