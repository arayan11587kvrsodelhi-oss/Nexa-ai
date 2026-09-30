/**
 * NEXA AI — browser security headers.
 *
 * This module is deliberately dependency-free so it can be imported by
 * `next.config.ts` (which runs outside the `@/` alias) *and* unit-tested
 * directly. `next.config.ts` is the only place these are attached, so the
 * policy and the tests can never drift apart.
 *
 * ---------------------------------------------------------------------------
 * CSP: how this policy was derived
 * ---------------------------------------------------------------------------
 * The application was inspected rather than assumed:
 *
 *  - Inline scripts: exactly ONE of our own — `theme-bootstrap.tsx`, whose body
 *    is a *static* string. Next.js additionally emits an inline RSC flight
 *    payload (`self.__next_f.push(...)`) whose content differs per request, so
 *    it cannot be whitelisted by hash.
 *  - A nonce would fix that, but only by forcing every page to render
 *    dynamically. `/login`, `/signup`, `/forgot-password` and `/reset-password`
 *    are currently prerendered, so a nonce would change existing rendering
 *    behaviour. That is a bigger change than a hardening pass should make, so
 *    `'unsafe-inline'` is retained for `script-src` and the reason is recorded
 *    here rather than left as an unexplained exception.
 *  - No `unsafe-eval`. Nothing here evaluates strings; the calculator uses a
 *    hand-written recursive-descent parser precisely so it does not need to.
 *    `unsafe-eval` is granted in development only, because React Fast Refresh
 *    requires it.
 *  - Every browser-side `fetch` targets a relative `/api/...` path, so
 *    `connect-src 'self'` blocks *all* exfiltration channels (fetch, XHR,
 *    sendBeacon, WebSocket, EventSource) without breaking anything. This is the
 *    single most valuable directive here, precisely because `script-src` cannot
 *    be made strict.
 *  - Fonts are self-hosted by `next/font`, so no `fonts.googleapis.com` source
 *    is needed and no third-party origin is contacted from the browser.
 *  - The app renders no `<img>` and no `next/image`; icons are inline SVG.
 */

/**
 * True while `next dev` is running.
 *
 * Read from `NODE_ENV` rather than passed in, so `next.config.ts` and the tests
 * cannot disagree about which policy is in force.
 */
/**
 * Cryptographically random, per-request CSP nonce.
 *
 * A nonce is worthless if it can be guessed or reused, so this must be CSPRNG
 * output, never a counter or a timestamp. The Edge runtime has `crypto` but not
 * `node:crypto`, so Web Crypto is used deliberately.
 */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function isDev(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * Content-Security-Policy.
 *
 * Directive by directive:
 *
 *  - `default-src 'self'`  — deny by default; anything unlisted cannot load.
 *  - `script-src`          — see the note above on `'unsafe-inline'`.
 *  - `style-src`           — `'unsafe-inline'` is required by the ~70 React
 *                            `style={{...}}` attributes across the UI. Inline
 *                            *attributes* are governed by `style-src-attr`; CSS
 *                            injection is a far smaller risk than script
 *                            injection, and removing this would visibly break
 *                            the theme-aware borders and colours.
 *  - `img-src`             — no remote images exist; `data:`/`blob:` only.
 *  - `font-src 'self'`     — self-hosted `next/font` output.
 *  - `connect-src 'self'`  — the only network permission the browser gets, and
 *                            the reason an XSS cannot phone home.
 *  - `object-src 'none'`   — no plugins, ever.
 *  - `base-uri 'self'`     — stops a `<base>` tag re-pointing every relative
 *                            URL at an attacker's host.
 *  - `form-action 'self'`  — stops credential-harvesting forms posting offsite.
 *  - `frame-ancestors 'none'` — clickjacking defence (the modern replacement
 *                            for `X-Frame-Options`).
 *  - `manifest-src 'self'` — PWA manifest, if one is ever added.
 *  - `worker-src 'self'`   — no workers today; listed so a future worker cannot
 *                            be loaded from an arbitrary origin by default.
 *  - `upgrade-insecure-requests` — production only. In development this would
 *                            rewrite `http://localhost:3000` to `https://` and
 *                            break the dev server outright.
 */
export function contentSecurityPolicy(nonce?: string): string {
  const directives: string[] = [
    "default-src 'self'",
    isDev()
      ? // React Fast Refresh compiles modules with eval() during `next dev`.
        // A development-only affordance, absent in production.
        `script-src 'self' 'unsafe-inline' 'unsafe-eval'${nonce ? ` 'nonce-${nonce}'` : ""}`
      : nonce
        ? // Phase 5.5: with a per-request nonce, `'unsafe-inline'` is no longer
          // required — and must not be listed, because browsers ignore
          // `'unsafe-inline'` for `script-src` whenever a nonce or hash is
          // present. Listing it would misdescribe what is actually enforced.
          `script-src 'self' 'nonce-${nonce}'`
        : // No nonce available (e.g. a non-document response). Falls back to
          // the pre-5.5 policy rather than emitting an unusable header.
          "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    isDev()
      ? // HMR over a websocket. No production browser code opens a socket.
        "connect-src 'self' ws: wss:"
      : "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    "worker-src 'self'",
  ];

  if (!isDev()) {
    // Force https for any subresource a future change might introduce.
    directives.push("upgrade-insecure-requests");
  }

  return directives.join("; ");
}

/**
 * Every security header NEXA sends, as a flat name/value list.
 *
 * Each entry is here for a specific reason, not for completeness:
 *
 *  - `X-Content-Type-Options: nosniff` — stop a browser re-interpreting a
 *    response as a script type it was not served as.
 *  - `Referrer-Policy: no-referrer` — the strongest setting. This app makes no
 *    outbound links and runs no analytics, so a referrer has no legitimate use
 *    but does carry conversation ids and reset tokens in its path.
 *  - `Permissions-Policy` — the app uses none of these device capabilities, so
 *    each is denied outright rather than merely unused.
 *  - `X-Frame-Options: DENY` — legacy clickjacking defence for browsers that
 *    predate `frame-ancestors`. Harmless alongside it.
 *  - `X-XSS-Protection: 0` — deliberately disables the *old* XSS auditor. That
 *    filter was itself exploitable and has caused vulnerabilities; turning it
 *    off is the modern recommendation.
 *  - `X-DNS-Prefetch-Control: off` — a private workspace contacts no third
 *    party, so prefetching is pure DNS metadata leakage.
 *  - `Strict-Transport-Security` — production only. Sent over plain http during
 *    local development it can make a browser refuse to load the dev server at
 *    all. Deliberately scoped to the apex domain: `includeSubDomains` and
 *    `preload` would reach sibling hosts on a shared domain, which is not this
 *    application's call to make.
 *
 * Deliberately NOT set: `Cross-Origin-Opener-Policy` / `-Embedder-Policy` /
 * `-Resource-Policy`. There is no cross-origin window, no SharedArrayBuffer and
 * no worker requirement, so they protect nothing here while a `same-origin` COOP
 * would silently break any future OAuth or payment popup.
 */
export function securityHeaders(): Array<{ key: string; value: string }> {
  const headers: Array<{ key: string; value: string }> = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "no-referrer" },
    {
      key: "Permissions-Policy",
      value: [
        "camera=()",
        "microphone=()",
        "geolocation=()",
        "payment=()",
        "usb=()",
        "accelerometer=()",
        "gyroscope=()",
        "magnetometer=()",
      ].join(", "),
    },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-XSS-Protection", value: "0" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
  ];

  if (!isDev()) {
    headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000" });
  }

  return headers;
}
