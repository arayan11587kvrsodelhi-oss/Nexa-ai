/**
 * Applies the persisted theme before first paint so the UI never flashes
 * the wrong colour scheme. Must stay dependency-free and synchronous.
 *
 * Phase 5.5: this is the one inline script NEXA renders itself, and Next.js
 * cannot stamp a nonce onto it — only onto the scripts Next itself emits. The
 * nonce is therefore passed in and applied explicitly, or the production CSP
 * (`script-src 'self' 'nonce-…'`, with no `'unsafe-inline'`) would block it and
 * the page would flash the wrong theme.
 */
const script = `(function(){try{
var t = localStorage.getItem("nexa.theme");
if (t !== "light" && t !== "dark") {
  t = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
document.documentElement.setAttribute("data-theme", t);
}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;

export function ThemeBootstrap({ nonce }: { nonce?: string }) {
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: script }} />;
}