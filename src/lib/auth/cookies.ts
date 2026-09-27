export const SESSION_COOKIE = "nexa_session";

/** 30 days. Sessions are refreshed on login only, not rolled on every request. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  };
}

/** Expired-session cookie variant used on logout. */
export function sessionClearCookieOptions() {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(0),
  };
}
