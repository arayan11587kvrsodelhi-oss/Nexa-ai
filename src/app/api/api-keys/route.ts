/**
 * API key management for the signed-in NEXA app.
 *
 * This is a thin, session-authenticated HTTP surface over the *existing*
 * `ApiKeyService`. It introduces no second key system and no new storage.
 *
 * Security properties this route is responsible for:
 *
 *  - the user is resolved from the server-side session, never from the body,
 *    the query string, or a header the client controls;
 *  - every query is scoped by `userId`, so one user can never see or revoke
 *    another user's key;
 *  - the plaintext key appears in exactly one response — the creation response —
 *    and is never logged, never stored, and never returned again;
 *  - the response carrying the plaintext is `no-store`, so it does not linger in
 *    a proxy or a browser cache.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth/guard";
import { ApiError, toErrorResponse } from "@/lib/api/errors";
import { checkApiKeyCreationLimit } from "@/lib/gateway/rate-limit-guard";
import { ApiKeyService } from "@/lib/gateway/api-key-store";

export const dynamic = "force-dynamic";
/** Node runtime: the store and its digest hashing are server-side only. */
export const runtime = "nodejs";

/** Bounds a key name so a hostile client cannot store megabytes per key. */
const MAX_NAME_LENGTH = 80;

const createSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the key a name so you can recognise it later.")
    .max(MAX_NAME_LENGTH, `Keep the name under ${MAX_NAME_LENGTH} characters.`),
  expiresInDays: z
    .number()
    .int()
    .positive()
    .max(3650, "Expiry must be at most 3650 days.")
    .optional(),
});

/**
 * Only ever returns the metadata that is safe to render.
 *
 * `keyHash` and the pepper are structurally impossible to leak here: the
 * function accepts `ApiKeySummary`, which does not carry them.
 */
function toPublicSummary(summary: {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}) {
  const expired = summary.expiresAt !== null && Date.parse(summary.expiresAt) <= Date.now();
  return {
    id: summary.id,
    name: summary.name,
    /** Display-only fragment, e.g. `nexa_sk_a1b2c3…`. Never the key. */
    keyPrefix: summary.keyPrefix,
    createdAt: summary.createdAt,
    lastUsedAt: summary.lastUsedAt,
    revokedAt: summary.revokedAt,
    expiresAt: summary.expiresAt,
    status: summary.revokedAt ? "revoked" : expired ? "expired" : "active",
  };
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const keys = await ApiKeyService.list(user.id);
    return NextResponse.json({ keys: keys.map(toPublicSummary) });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}

export async function POST(req: NextRequest) {
  try {
    // The session decides the user. A header or body field naming a different
    // user is ignored entirely.
    const user = await requireUser(req);

    // Bounds key spam for this account. Shared across every serverless
    // instance because the counter lives in PostgreSQL.
    //
    // The previous guard here was both weaker and inert: it was an in-process
    // `Map` (per-instance, so N instances meant N × the limit) *and* its
    // return value was discarded, so it never refused a request at all.
    const decision = await checkApiKeyCreationLimit(user.id);
    if (!decision.allowed) {
      const headers: Record<string, string> = {
        "Retry-After": String(decision.retryAfterSeconds),
      };
      if (!decision.storeUnavailable) {
        headers["X-RateLimit-Limit"] = String(decision.limit);
        headers["X-RateLimit-Remaining"] = String(decision.remaining);
      }
      // Same `{ error, code }` body as any other ApiError from this surface, so
      // a client sees one shape. A store outage is still a 429 here because
      // `ApiError` has no distinct "temporarily unavailable" code, and the
      // message is deliberately different from a quota refusal.
      return NextResponse.json(
        {
          error: decision.deniedByStoreFailure
            ? "The gateway is temporarily unable to accept requests. Please retry shortly."
            : "Too many keys created. Please try again later.",
          code: "RATE_LIMITED",
        },
        { status: 429, headers }
      );
    }

    const raw = await req.json().catch(() => null);
    const parsed = createSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw ApiError.badRequest(
        first?.message ?? "That key could not be created.",
        { cause: first?.path.join(".") }
      );
    }

    const { plaintext, summary } = await ApiKeyService.create(
      user.id,
      parsed.data.name,
      parsed.data.expiresInDays ? { expiresInDays: parsed.data.expiresInDays } : {}
    );

    // The ONLY response that ever contains the plaintext.
    // `no-store` keeps it out of shared caches and the back/forward cache.
    return NextResponse.json(
      { key: toPublicSummary(summary), plaintext },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}
