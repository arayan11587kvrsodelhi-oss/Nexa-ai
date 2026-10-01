/**
 * Applies the persisted theme before first paint so the UI never flashes
 * the wrong colour scheme. Must stay dependency-free and synchronous.
 *
 * ## Why this is `next/script` and not a bare `<script nonce={...}>` element
 *
 * Browsers implement CSP *nonce hiding*: once a nonced `<script>` has been
 * parsed, the `nonce` content attribute is emptied while the internal nonce
 * (the IDL `HTMLScriptElement.nonce` property) is kept. This is deliberate —
 * it stops scripts from reading the nonce back out of the DOM.
 *
 * React 19 has no special case for `nonce`. During hydration it diffs every
 * prop against the DOM via `getAttribute(prop)`, which returns `""` for a
 * hidden nonce, so a React-owned `<script nonce={nonce}>` can never match:
 *
 *     Prop `nonce` did not match. Server: "" Client: "<32 hex chars>"
 *
 * Note which side is which: `Server` is the value React read from the DOM
 * (`warnForPropDifference` is called with `getAttribute`'s result), and
 * `Client` is React's own prop. The DOM is correct; React's read of it is not.
 *
 * Changing *where the nonce is read from* cannot fix this, because the
 * divergence happens in the browser after the HTML is parsed. Verified in
 * Chromium: the served HTML carries the real nonce, and after parsing
 * `getAttribute('nonce') === ""` while `el.nonce` still holds all 32 chars.
 *
 * Next.js's own scripts are immune to this for one reason: they are written
 * straight into the HTML stream instead of being rendered as React elements,
 * so React never diffs them. Measured on this page — 24 nonced scripts, and
 * only the one rendered here carried a `__reactProps$` key.
 *
 * `next/script` is **not** a valid substitute, and was measured failing: with
 * `strategy="beforeInteractive"`, Next wraps inline content in its
 * `self.__next_s` runtime queue, which materialises a fresh `<script>` that
 * cannot inherit the nonce. The policy then blocks it and the theme is never
 * applied.
 *
 * ## Why this is an improvement, not a workaround
 *
 * `script-src` already contains `'self'`, so this file is permitted exactly
 * because it is same-origin; no nonce attribute is needed on it, so there is
 * nothing for React to disagree about. This *removes* an inline script from
 * the page rather than silencing a mismatch — strictly stronger than before,
 * since there is one fewer inline script an attacker would need a nonce
 * injection to reach. The nonce-based policy is untouched and still guards
 * every script the framework emits.
 *
 * A plain `<script src>` in the head is render-blocking, so it executes before
 * the body is first painted and cannot cause a flash of the wrong theme. An
 * `async` or dynamically injected script would not be safe here.
 *
 * The synchronous load is intentional and is the whole point of this file, so
 * the `no-sync-scripts` rule is disabled below. That rule targets third-party
 * scripts, where blocking first paint is a performance cost; here deferring it
 * would let the body paint in the wrong colour and then repaint, which is the
 * exact defect this script exists to prevent. The file is same-origin and a
 * few hundred bytes, and is requested in parallel with the document, so it
 * costs no additional round trip.
 */
export function ThemeBootstrap() {
  // eslint-disable-next-line @next/next/no-sync-scripts
  return <script src="/theme-bootstrap.js" />;
}