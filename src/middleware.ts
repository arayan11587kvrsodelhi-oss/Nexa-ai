import { NextRequest, NextResponse } from "next/server";

/**
 * Edge middleware — route protection for NEXA.
 *
 * This layer checks ONLY that a session cookie is present. It cannot reach the
 * database (edge runtime), so validity and ownership are enforced again in
 * every API route via `requireUser` / scoped queries. An invalid or expired
 * cookie passes middleware but is rejected at the data layer — fail closed.
 *
 * Redirects are pre-auth only. After login the client goes to /chat via / .
 */

const PROTECTED_PREFIXES = [
  "/chat",
  "/c/",
  "/conversations",
  "/projects",
  "/files",
  "/documents",
  "/code",
  "/agents",
  "/models",
  "/playground",
  "/settings",
];

const AUTH_PAGES = ["/login", "/signup"];

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const hasCookie = Boolean(req.cookies.get("nexa_session")?.value);

  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`)
  );
  const isAuthPage = AUTH_PAGES.includes(pathname);

  if (isProtected && !hasCookie) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  if (isAuthPage && hasCookie) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Protect workspace routes and auth pages; skip API, static, and Next internals.
    "/((?!api|_next/static|_next/image|favicon.ico).*)",
  ],
};
