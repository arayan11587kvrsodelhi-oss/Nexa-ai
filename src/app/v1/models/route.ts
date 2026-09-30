/**
 * GET /v1/models — OpenAI-compatible model catalogue.
 *
 * The list is what providers *actually reported*, never a hardcoded marketing
 * list. A model with no health observation is `nexa_availability: "unknown"`,
 * not `"available"` — clients can tell the difference between "we know this
 * exists" and "we know this works".
 *
 * Auth: `Authorization: Bearer nexa_sk_…`. Not a session cookie.
 */
import { requireApiKey } from "@/lib/gateway/api-auth";
import {
  enforceRateLimit,
  isRateLimitRejection,
  rateLimitHeadersFor,
} from "@/lib/gateway/rate-limit-guard";
import { GatewayError } from "@/lib/gateway/errors";
import { NexaGateway } from "@/lib/gateway/gateway";
import { logGateway, newRequestId } from "@/lib/gateway/logging";
import { errorResponse } from "@/lib/gateway/openai";
import { GatewayModelRegistry } from "@/lib/gateway/registry";

export const dynamic = "force-dynamic";
/** Node runtime: model discovery uses fetch with custom timeouts. */
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();
  try {
    const principal = await requireApiKey(request, requestId);

    // After authentication: an invalid key must not spend a valid key's quota.
    await enforceRateLimit({ kind: "models", principal, request });

    // Performs a bounded discovery pass and records real health observations.
    const models = await NexaGateway.listModels();

    logGateway({
      requestId,
      event: "models",
      note: `models=${models.length} key=${principal.displayPrefix}`,
    });

    return Response.json(
      { object: "list", data: GatewayModelRegistry.toOpenAIModels(models) },
      {
        headers: {
          "Cache-Control": "no-store",
          "X-NEXA-Request-Id": requestId,
        },
      }
    );
  } catch (error) {
    return renderError(error, requestId);
  }
}

function renderError(error: unknown, requestId: string): Response {
  if (error instanceof GatewayError) {
    const { status, body } = errorResponse(error);
    return Response.json(body, {
      status,
      headers: {
        "X-NEXA-Request-Id": requestId,
        ...(isRateLimitRejection(error) ? rateLimitHeadersFor(error) : {}),
      },
    });
  }
  logGateway({ requestId, event: "failure", reason: "unhandled_models_error" });
  const internal = new GatewayError("GatewayError", "Could not list models.", {
    category: "unknown",
  });
  const { status, body } = errorResponse(internal);
  return Response.json(body, {
    status,
    headers: { "X-NEXA-Request-Id": requestId },
  });
}
