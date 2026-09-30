import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/security/headers";

/**
 * Security headers are defined in `src/lib/security/headers.ts` rather than
 * inline here, for two reasons:
 *
 *  1. The policy is derived from an inspection of this application (inline
 *     scripts, styles, fonts, network egress), and that reasoning belongs with
 *     the code, not in a config file nobody re-reads.
 *  2. It makes the policy unit-testable. Testing `next.config.ts` directly
 *     would assert against Next's own plumbing; testing the exported function
 *     asserts the thing that is actually sent.
 *
 * **CSP is deliberately NOT set here.** Phase 5.5 moved it into `middleware.ts`
 * so it can carry a per-request nonce. Browsers enforce the *intersection* of
 * every CSP header on a response, so shipping a static, nonce-less policy from
 * `next.config.ts` alongside the nonce-bearing one would block Next's own
 * nonced scripts and break the app. The non-CSP headers below are static and
 * remain here; CSP is attached in middleware for document responses.
 */
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders(),
      },
    ];
  },
};

export default nextConfig;
