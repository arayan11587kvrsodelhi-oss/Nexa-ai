/**
 * NEXA AI Gateway — authentication for the public `/v1/*` surface.
 *
 * These routes are deliberately *not* session-authenticated. A browser cookie
 * and a server-to-server API key are different credentials with different
 * lifetimes, and accepting either for either is how keys end up pasted into
 * web UIs and session cookies end up in CI logs. So:
 *
 *  - `/v1/*` requires `Authorization: Bearer nexa_sk_…` and nothing else.
 *  - A missing key is 401. A malformed or unknown key is 401 too — same
 *    response either way, so an attacker cannot probe which keys exist.
 *
 * Every rejection is logged with the request id and the key's *display prefix*
 * at most, never the key.
 */
import { ApiKeyService, type AuthenticatedApiKey } from "./api-key-store";
import { extractBearerToken } from "./api-keys";
import { GatewayError } from "./errors";
import { logGateway } from "./logging";

export interface ApiKeyPrincipal extends AuthenticatedApiKey {
  /** Display prefix only, for log correlation. Never the key. */
  displayPrefix: string;
}

function unauthorized(message: string): GatewayError {
  return new GatewayError("GatewayError", message, {
    category: "authentication_failure",
    status: 401,
  });
}

/**
 * Resolve the API key on a `/v1/*` request.
 *
 * Throws a 401-shaped `GatewayError` on any failure so callers can use one
 * error path for auth and upstream problems.
 */
export async function requireApiKey(
  request: Request,
  requestId: string
): Promise<ApiKeyPrincipal> {
  const header = request.headers.get("authorization");
  const token = extractBearerToken(header);

  if (!token) {
    logGateway({
      requestId,
      event: "auth_failure",
      reason: "missing_authorization_header",
    });
    // A body/header hint is the difference between a client that can fix this
    // in one line and one that opens a support ticket.
    throw unauthorized(
      "Missing API key. Send `Authorization: Bearer nexa_sk_…`. Create a key from NEXA Settings → API keys."
    );
  }

  let principal: AuthenticatedApiKey | null = null;
  try {
    principal = await ApiKeyService.authenticate(token);
  } catch (error) {
    // A database outage must not be reported as a bad key: that sends the
    // caller off to rotate a perfectly good credential.
    logGateway({
      requestId,
      event: "auth_failure",
      reason: "key_store_unavailable",
      errorCategory: "temporary_upstream_failure",
    });
    throw new GatewayError("ProviderUnavailable", "Key store is temporarily unavailable.", {
      category: "temporary_upstream_failure",
      status: 503,
      cause: error,
    });
  }

  if (!principal) {
    logGateway({
      requestId,
      event: "auth_failure",
      reason: "invalid_or_revoked_key",
    });
    throw unauthorized("Invalid or revoked API key.");
  }

  // Fire-and-forget: usage accounting must not delay the response.
  void ApiKeyService.touch(principal.keyId).catch(() => undefined);

  return { ...principal, displayPrefix: `${token.slice(0, 16)}…` };
}
