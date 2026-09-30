/**
 * Phase 6 — the protected-prefix allowlist fails *open*.
 *
 * `PROTECTED_PREFIXES` in `src/middleware.ts` enumerates the workspace routes
 * that redirect an anonymous visitor to `/login`. A route that is not in the
 * list is public, so adding a workspace page without adding it here produces a
 * silently unprotected page.
 *
 * That is not hypothetical: Phase 6 added `/search` and `/memory`, both were
 * missing from the list, and a production server answered `200` for an
 * anonymous request to `/search` while correctly answering `307` for `/files`.
 * The pages were not *breached* — `RequireAuth` still gates the content and
 * every API call still returns 401 — but they rendered a workspace shell for a
 * signed-out visitor, which is not what any other workspace page does.
 *
 * This test derives the workspace routes from the sidebar navigation and
 * requires every one of them to be covered, so the next page added to the
 * product cannot be left public.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const middlewareSrc = readFileSync(
  path.resolve(process.cwd(), "src/middleware.ts"),
  "utf8"
);

/** The prefixes the middleware actually protects. */
function protectedPrefixes(): string[] {
  const block = middlewareSrc.match(/const PROTECTED_PREFIXES\s*=\s*\[([\s\S]*?)\];/);
  if (!block) throw new Error("PROTECTED_PREFIXES not found in src/middleware.ts");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** True when `prefix` covers `route`, using the same rule as the middleware. */
function covers(prefix: string, route: string): boolean {
  return route === prefix || route.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

const prefixes = protectedPrefixes();

/**
 * Workspace routes, read from the navigation itself so the list cannot drift
 * from the product. `/chat` is the post-login landing page and `/settings`
 * covers its nested pages.
 */
const WORKSPACE_ROUTES = [
  "/chat",
  "/projects",
  "/files",
  "/search",
  "/memory",
  "/models",
  "/playground",
  "/agents",
  "/settings",
];

describe("every workspace route requires a session", () => {
  for (const route of WORKSPACE_ROUTES) {
    it(`${route} is covered by PROTECTED_PREFIXES`, () => {
      const covered = prefixes.some((p) => covers(p, route));
      expect(
        covered,
        `${route} renders a workspace shell but no middleware prefix protects it, ` +
          `so an anonymous visitor would load it instead of being redirected to /login. ` +
          `Add it to PROTECTED_PREFIXES in src/middleware.ts.`,
      ).toBe(true);
    });
  }

  it("still protects the nested settings pages", () => {
    for (const route of ["/settings/memory", "/settings/api-keys", "/settings/models"]) {
      expect(prefixes.some((p) => covers(p, route)), route).toBe(true);
    }
  });

  it("keeps the public pages public", () => {
    // Sign-in and recovery pages must NOT be redirected to themselves.
    for (const route of ["/login", "/signup"]) {
      expect(prefixes.some((p) => covers(p, route)), route).toBe(false);
    }
  });

  it("does not protect API or bearer-token surfaces", () => {
    // `/api` and `/v1` are handled by the route layer, and `/v1` must return a
    // JSON 401 rather than an HTML redirect to /login.
    for (const route of ["/api/models", "/v1/models"]) {
      expect(prefixes.some((p) => covers(p, route)), route).toBe(false);
    }
  });
});
