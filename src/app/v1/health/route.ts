/**
 * GET /v1/health — gateway health, for operators and CI.
 *
 * Requires an API key: this route performs real provider probes (upstream
 * network calls), so it must not be an open endpoint that anyone can use to
 * turn NEXA into a request amplifier against a third party.
 *
 * `ok` is only true when something is actually reachable. A gateway with no
 * provider configured reports 503 rather than a cheerful 200, because a 200
 * here is a signal to a load balancer.
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
import { publicProviderConfig } from "@/lib/gateway/config";

export const dynamic = "force-dynamic";
/** Node runtime: health probes use fetch with custom timeouts. */
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();
  try {
    const principal = await requireApiKey(request, requestId);
    // After authentication, and shaped so a trivial flood cannot turn this into
    // a provider-probe amplifier. Fails open: a monitor must still be able to see
    // a gateway that is healthy while the limiter store is down.
    await enforceRateLimit({ kind: "health", principal, request });
    const report = await NexaGateway.health();

    logGateway({
      requestId,
      event: "health",
      note: `ok=${report.ok} status=${report.status} models=${report.models.total}`,
    });

    const { providers, providerOrder, models, ...summary } = report;
    const context = NexaGateway.context();

    return Response.json(
      {
        ...summary,
        models,
        providerOrder,
        // Credential-free projection: hasCredential, never the credential.
        configuration: context.configs.map(publicProviderConfig),
        providers: providers.map((provider) => ({
          provider: provider.provider,
          status: provider.status,
          ok: provider.ok,
          message: provider.message,
          latencyMs: provider.latencyMs,
          modelCount: provider.models?.length ?? 0,
          checkedAt: provider.checkedAt,
          errorCategory: provider.errorCategory ?? null,
        })),
      },
      {
        status: report.ok ? 200 : 503,
        headers: {
          "Cache-Control": "no-store",
          "X-NEXA-Request-Id": requestId,
        },
      }
    );
  } catch (error) {
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
    logGateway({ requestId, event: "failure", reason: "unhandled_health_error" });
    const internal = new GatewayError("GatewayError", "Could not determine gateway health.", {
      category: "unknown",
    });
    const { status, body } = errorResponse(internal);
    return Response.json(body, {
      status,
      headers: { "X-NEXA-Request-Id": requestId },
    });
  }
}
