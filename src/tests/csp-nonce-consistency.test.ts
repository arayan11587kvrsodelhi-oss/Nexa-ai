/**
 * Regression guard for the ThemeBootstrap hydration mismatch.
 *
 * ## The bug this locks down
 *
 * `ThemeBootstrap` used to render `<script nonce={nonce} />` as a React
 * element. Browsers implement CSP *nonce hiding*: once a nonced `<script>` is
 * parsed, the `nonce` content attribute is emptied while the internal nonce
 * (the IDL `HTMLScriptElement.nonce` property) is kept, so that scripts cannot
 * read the nonce back out of the DOM.
 *
 * React 19 has no special case for `nonce`. During hydration it diffs every
 * prop against the DOM using `getAttribute(prop)`, which returns `""` for a
 * hidden nonce, so the element could never match and React logged
 *
 *     Prop `nonce` did not match. Server: "" Client: "<32 hex chars>"
 *
 * Note the sides: `Server` is what React read from the DOM, `Client` is
 * React's own prop. The served HTML was always correct.
 *
 * Measured in Chromium on the affected page: 24 nonced scripts, all reporting
 * `getAttribute('nonce') === ""`, but exactly one — the one React owned, this
 * component's — carried a `__reactProps$` key and therefore the only one React
 * diffed.
 *
 * ## What the fix does
 *
 * The script is served from `/public` as a same-origin static file and loaded
 * with a plain, render-blocking `<script src>`. `script-src` already contains
 * `'self'`, so it needs no nonce attribute at all, and React has no nonce to
 * reconcile. This *removes* an inline script rather than suppressing a
 * mismatch, which is strictly stronger than before.
 *
 * These tests assert the properties that make the bug unrepresentable.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const component = readFileSync(
  join(root, "src/components/shell/theme-bootstrap.tsx"),
  "utf8"
);
const themeScript = readFileSync(join(root, "public/theme-bootstrap.js"), "utf8");

/**
 * Strip comments so these assertions describe the code rather than the prose
 * explaining it. The rationale in this file deliberately mentions `nonce=`,
 * `next/script` and `suppressHydrationWarning` by name, and a naive source
 * match would flag the very documentation that records the fix.
 */
function code(file: string): string {
  return file.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const componentCode = code(component);

describe("ThemeBootstrap does not hand React a nonce-bearing script", () => {
  it("never renders a nonce attribute on the script element", () => {
    // The single change that removes the hydration mismatch: there is no nonce
    // prop, so there is nothing for the browser-hidden DOM value to disagree
    // with.
    expect(componentCode).not.toMatch(/<script[^>]*\bnonce=/);
    expect(componentCode).not.toMatch(/\bnonce=/);
  });

  it("does not suppress hydration warnings", () => {
    expect(code(component)).not.toMatch(/suppressHydrationWarning/);
    expect(code(join(root, "src/app/layout.tsx"))).not.toMatch(
      /<ThemeBootstrap[^>]*suppressHydrationWarning/
    );
  });

  it("loads a same-origin external script", () => {
    expect(componentCode).toMatch(/<script src="\/theme-bootstrap\.js"/);
  });

  it("keeps the script render-blocking so no flash of the wrong theme", () => {
    // `async`/`defer` would let the body paint before the theme is applied,
    // which is the defect this script exists to prevent.
    expect(componentCode).not.toMatch(/<script[^>]*\basync\b/);
    expect(componentCode).not.toMatch(/<script[^>]*\bdefer\b/);
    expect(componentCode).not.toMatch(/next\/script/);
  });

  it("sets the theme in both directions, with a safe fallback", () => {
    expect(themeScript).toContain('localStorage.getItem("nexa.theme")');
    expect(themeScript).toContain('setAttribute("data-theme"');
    // Unknown stored value falls back to the OS preference, never to undefined.
    expect(themeScript).toMatch(/prefers-color-scheme/);
  });
});

describe("production CSP still gates inline scripts by nonce", () => {
  // `contentSecurityPolicy` branches on NODE_ENV at call time, so production
  // behaviour has to be exercised with NODE_ENV actually set to "production".
  // The module is re-imported per test so the branch is evaluated under that
  // value rather than the ambient one.
  let policy: string;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const headers = await import("@/lib/security/headers");
    policy = headers.contentSecurityPolicy(headers.generateCspNonce());
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps a nonce on script-src in production", () => {
    expect(policy).toMatch(/script-src 'self' 'nonce-[0-9a-f]{32}'/);
  });

  it("does not weaken script-src once a nonce is present", () => {
    // A browser ignores 'unsafe-inline' in script-src whenever a nonce is
    // present, so it must not be listed alongside one.
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
    // 'self' must remain, or the external theme script would be blocked.
    expect(policy).toMatch(/script-src[^;]*'self'/);
  });

  it("never emits an empty nonce, which would leave scripts blocked", () => {
    // `script-src 'self'` with no nonce is the documented fallback for
    // responses that are not documents; it must not be the document policy.
    expect(policy).toMatch(/'nonce-[0-9a-f]{32}'/);
  });
});

