import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "./cookies";
import { SessionService, type SessionUser } from "./session";
import { ApiError } from "@/lib/api/errors";

export { SESSION_COOKIE };
export type { SessionUser };

export function readSessionToken(req: NextRequest): string | undefined {
  return req.cookies.get(SESSION_COOKIE)?.value;
}

/**
 * Resolve the current user for an API request.
 * Returns null when unauthenticated — callers decide between 401 and a
 * redirect. Never throws.
 */
export async function getCurrentUser(req: NextRequest): Promise<SessionUser | null> {
  try {
    return await SessionService.getUserByToken(readSessionToken(req));
  } catch (err) {
    // A database outage must not be reported as "not logged in" at the route
    // level, but it also must not crash the handler; routes that require auth
    // surface 503 through the thrown error below instead.
    console.warn("[nexa] session lookup failed:", err);
    return null;
  }
}

/**
 * Authentication guard for every user-owned API route.
 *
 * Throws ApiError(401) when there is no valid session. Usage:
 *
 *   const user = await requireUser(req);
 *   // every subsequent query filters by user.id
 */
export async function requireUser(req: NextRequest): Promise<SessionUser> {
  let token = readSessionToken(req);
  let user: SessionUser | null = null;
  try {
    user = await SessionService.getUserByToken(token);
  } catch (err) {
    throw ApiError.databaseUnavailable(err);
  }
  if (!user) throw ApiError.unauthorized();
  return user;
}
