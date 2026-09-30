import { NextRequest, NextResponse } from "next/server";
import { contentSecurityPolicy, generateCspNonce } from "@/lib/security/headers";

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
  // Phase 6: the web-search and memory workspaces. Both render a shell and
  // reach authenticated APIs, so both belong here exactly as much as
  // `/files` does.
  //
  // This list is an allowlist, so it fails *open*: a new workspace page is
  // public until someone remembers to add it. Phase 6 added two routes and
  // both were silently unprotected until the production server was started and
  // `/search` answered 200 to an anonymous request while `/files` correctly
  // answered 307. `security-headers.test.ts` now pins every entry in the
  // sidebar navigation against this list so the next one cannot slip through.
  "/search",
  "/memory",
  "/settings",
];

const AUTH_PAGES = ["/login", "/signup"];

/** Methods that can change state and therefore need a cross-origin check. */
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Reject a browser request that is *provably* cross-site.
 *
 * NEXA already blocks the practical CSRF vector without this: the session
 * cookie is `HttpOnly` + `SameSite=Lax`, and every state-changing endpoint is
 * a POST/PUT/PATCH/DELETE (verified: no handler mutates state on GET). A
 * cross-site browser POST therefore does not carry the session cookie at all.
 *
 * This is defence in depth for what that leaves open, and it is deliberately
 * not a token system:
 *
 *  - a same-site attack from a sibling subdomain, which `SameSite=Lax` allows;
 *  - a client that ignores `SameSite` entirely;
 *  - a future change to the cookie attributes silently reopening the hole.
 *
 * Two deliberate omissions, both to avoid breaking legitimate traffic:
 *
 *  - **API-key clients are untouched.** `/v1` is excluded by the matcher below
 *    and is not cookie-authenticated, so bearer clients never reach this.
 *  - **A missing `Origin` is allowed.** Browsers always send `Origin` on a
 *    cross-site state-changing request, so its absence means a non-browser
 *    client (curl, a script, a server-to-server call) — not a forged browser
 *    attack. Rejecting it would break the API surface for no security gain.
 */
function isCrossSiteRequest(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false; // non-browser client
  if (origin === "null") return true; // opaque origin: sandboxed iframe/file
  try {
    // Compare origins, not full URLs: a reverse proxy may present a different
    // host/port to the edge than the browser used.
    return new URL(origin).origin !== req.nextUrl.origin;
  } catch {
    // An unparseable Origin is not something we can vouch for.
    return true;
  }
}

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // Phase 5.5 — per-request CSP nonce.
  //
  // The nonce is attached to BOTH the request and the response. The response
  // copy is the policy the browser enforces; the request copy is what Next.js
  // reads (`get-script-nonce-from-header`) to stamp its own inline RSC flight
  // scripts. Without the request header, Next would emit nonced scripts that
  // the response policy does not permit.
  const nonce = generateCspNonce();
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy(nonce));

  // Cross-origin state-changing API requests are refused here, before any
  // route handler reads a body, queries the database, or starts a limiter.
  if (STATE_CHANGING.has(req.method) && isCrossSiteRequest(req)) {
    return new NextResponse(
      JSON.stringify({ error: "Cross-origin request refused.", code: "FORBIDDEN" }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  const hasCookie = Boolean(req.cookies.get("nexa_session")?.value);

  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`)
  );
  const isAuthPage = AUTH_PAGES.includes(pathname);

  if (isProtected && !hasCookie) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return withCsp(NextResponse.redirect(url), nonce);
  }

  if (isAuthPage && hasCookie) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return withCsp(NextResponse.redirect(url), nonce);
  }

  // Forward the nonce-bearing request headers so Next.js can stamp its inline
  // scripts, and set the policy on the way out for the browser.
  return NextResponse.next({
    request: { headers: requestHeaders },
    headers: { "Content-Security-Policy": contentSecurityPolicy(nonce) },
  });
}

/** Attach the policy to a response that never reaches the page renderer. */
function withCsp(response: NextResponse, nonce: string): NextResponse {
  response.headers.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  return response;
}

export const config = {
  matcher: [
    // Protect workspace routes and auth pages; skip API surfaces and Next
    // internals. `v1` is an API surface too: it authenticates with a bearer
    // API key, not a session cookie, so running this redirect layer over it
    // would be wrong (an API client must get a JSON 401, never an HTML
    // redirect to /login).
    "/((?!api|v1|_next/static|_next/image|favicon.ico).*)",
    // Phase 5.4: the cross-origin check DOES apply to `/api`, because those
    // routes are cookie-session-authenticated and state-changing. `v1` stays
    // excluded on purpose — it is bearer-authenticated, so browser CSRF rules
    // do not apply to it and must not be imposed on API clients.
    "/api/:path*",
  ],
};
