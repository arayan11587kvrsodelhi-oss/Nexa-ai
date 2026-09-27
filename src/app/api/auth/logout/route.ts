import { NextRequest, NextResponse } from "next/server";
import { SessionService } from "@/lib/auth/session";
import { SESSION_COOKIE, sessionClearCookieOptions } from "@/lib/auth/cookies";
import { toErrorResponse } from "@/lib/api/errors";
import { AuditLogger } from "@/lib/security/audit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    if (token) {
      const user = await SessionService.getUserByToken(token);
      await SessionService.destroySession(token);
      if (user) await AuditLogger.log("auth.logout", { userId: user.id });
    }
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, "", sessionClearCookieOptions());
    return res;
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}
