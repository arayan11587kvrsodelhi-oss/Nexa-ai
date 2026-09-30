/**
 * POST /v1/chat/completions — OpenAI-compatible completions.
 *
 * An existing OpenAI client is repointed at NEXA by changing one base URL and
 * one key. That compatibility is the whole point, so the details that actually
 * break clients are handled explicitly:
 *
 *  - `stream: true` is a real incremental SSE stream: a role frame, content
 *    deltas, a final frame carrying `finish_reason` + `usage`, then `[DONE]`.
 *  - Failures detected before the first byte are a proper HTTP status with an
 *    `error` envelope. Failures *after* the stream started can only be reported
 *    in-band, because the 200 is already on the wire.
 *  - `[DONE]` is always sent, so a client waiting for it never hangs.
 *  - A client that disconnects aborts the upstream, instead of paying for tokens
 *    nobody will read.
 *
 * Auth: `Authorization: Bearer nexa_sk_…`.
 */
import { requireApiKey, type ApiKeyPrincipal } from "@/lib/gateway/api-auth";
import { GatewayError } from "@/lib/gateway/errors";
import { NexaGateway } from "@/lib/gateway/gateway";
import { logGateway, newRequestId } from "@/lib/gateway/logging";
import {
  errorResponse,
  toChunkDeltaFrame,
  toChunkErrorFrame,
  toChunkFinalFrame,
  toChunkRoleFrame,
  toOpenAICompletion,
  type OpenAIStreamContext,
} from "@/lib/gateway/openai";
import { parseChatCompletionRequest, readJsonBody } from "@/lib/gateway/request";
import { GatewayModelRegistry } from "@/lib/gateway/registry";
import {
  enforceRateLimit,
  isRateLimitRejection,
  rateLimitHeadersFor,
} from "@/lib/gateway/rate-limit-guard";
import { GATEWAY_PROVIDER_IDS } from "@/lib/gateway/types";
import { encodeSseComment, encodeSseData } from "@/lib/gateway/sse";
import type { ChatRequest, ChatResponse } from "@/lib/gateway/types";

export const dynamic = "force-dynamic";
/** Node runtime: provider adapters and SSE handling are server-side. */
export const runtime = "nodejs";

/** Proxies and some SDKs buffer; these stop a long stream from being cut off. */
const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();

  let principal: ApiKeyPrincipal;
  let chatRequest: ChatRequest;
  try {
    principal = await requireApiKey(request, requestId);
    chatRequest = parseChatCompletionRequest(await readJsonBody(request));
  } catch (error) {
    return preStreamError(error, requestId);
  }

  // Rate limiting runs AFTER authentication, so an invalid key can never
  // consume a valid key's quota, and so a revoked key gets 401 rather than 429.
  try {
    await enforceRateLimit({ kind: "chat", principal, request });
  } catch (error) {
    return preStreamError(error, requestId);
  }

  // Aborting upstream when the client hangs up is what keeps a cancelled
  // request from still consuming a paid upstream.
  const abort = new AbortController();
  const onClientAbort = () => abort.abort();
  request.signal.addEventListener("abort", onClientAbort, { once: true });

  try {
    const outbound: ChatRequest = {
      ...chatRequest,
      requestId,
      signal: abort.signal,
      metadata: { ...chatRequest.metadata, nexaUserId: principal.userId },
    };
    return chatRequest.stream
      ? streamResponse(outbound, requestId, abort)
      : await jsonResponse(outbound, requestId);
  } finally {
    request.signal.removeEventListener("abort", onClientAbort);
  }
}

async function jsonResponse(
  chatRequest: ChatRequest,
  requestId: string
): Promise<Response> {
  try {
    const response = await NexaGateway.chat({ ...chatRequest, stream: false });
    return Response.json(toOpenAICompletion(response), {
      headers: { "X-NEXA-Request-Id": requestId },
    });
  } catch (error) {
    return preStreamError(error, requestId);
  }
}

function streamResponse(
  chatRequest: ChatRequest,
  requestId: string,
  abort: AbortController
): Response {
  const iterator = NexaGateway.streamChat({ ...chatRequest, stream: true })[
    Symbol.asyncIterator
  ]();

  // Frame identity. A client reads `model` from the first frame it sees, so it
  // must be stable for the whole stream.
  //
  // For a pinned request (`provider/model`) the selection is already decided, so
  // the provider prefix is resolved away immediately — otherwise the content
  // frames would carry the pinned form and the terminal frame the bare id.
  // For `auto` the real model is genuinely unknown until the provider answers,
  // so the requested string is reported until then.
  const pinned = GatewayModelRegistry.parseModelRef(
    chatRequest.model,
    GATEWAY_PROVIDER_IDS
  );
  let context: OpenAIStreamContext = {
    id: `chatcmpl_${requestId}`,
    created: Math.floor(Date.now() / 1000),
    model: pinned.provider ? pinned.model : chatRequest.model,
    provider: pinned.provider ?? "gateway",
  };
  let roleFrameSent = false;
  let closed = false;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (bytes: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(bytes);
        } catch {
          // Consumer cancelled between iterations; `cancel()` aborts upstream.
          closed = true;
        }
      };
      const send = (payload: unknown) => enqueue(encodeSseData(payload));

      try {
        // Flushes headers immediately so a client waiting on the first byte is
        // not left guessing while a provider thinks.
        enqueue(encodeSseComment("nexa gateway stream open"));

        for (;;) {
          const { done, value } = await iterator.next();
          if (done) break;
          const chunk = value;

          if (chunk.type === "token" || chunk.type === "reasoning") {
            // An empty delta is never forwarded: it renders as a stray empty
            // block in the client and is the shape of the duplication bug.
            if (!chunk.content) continue;
            if (!roleFrameSent) {
              roleFrameSent = true;
              send(toChunkRoleFrame(context));
            }
            send(toChunkDeltaFrame(context, chunk));
            continue;
          }

          if (chunk.type === "done") {
            const final: ChatResponse = chunk.data;
            context = adoptSelectedModel(context, final, roleFrameSent);
            if (!roleFrameSent) {
              roleFrameSent = true;
              send(toChunkRoleFrame(context));
            }
            send(toChunkFinalFrame(context, final));
            break;
          }

          if (chunk.type === "error") {
            send(toChunkErrorFrame(context, errorFromChunk(chunk)));
            break;
          }

          // `action` frames are NEXA-internal routing narration. They are
          // deliberately not forwarded here: an OpenAI client would render them
          // as assistant text. NEXA's own /api/chat still receives them.
        }
      } catch (error) {
        send(toChunkErrorFrame(context, errorFromThrown(error)));
      } finally {
        // `[DONE]` is always sent, including after an error frame, so a client
        // blocked on the sentinel always terminates.
        enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed by a client disconnect.
          }
        }
        void iterator.return?.(undefined);
      }
    },
    cancel() {
      // Consumer went away: stop paying for tokens nobody will read.
      closed = true;
      if (!abort.signal.aborted) abort.abort();
    },
  });

  return new Response(body, { headers: { ...SSE_HEADERS, "X-NEXA-Request-Id": requestId } });
}

/**
 * The final frame carries the model that actually answered, so a client that
 * asked for `auto` learns which one it got. It is adopted only while the stream
 * is still anonymous (no content frame sent), because changing `model`
 * mid-stream would make the frames inconsistent with each other.
 */
function adoptSelectedModel(
  context: OpenAIStreamContext,
  final: ChatResponse,
  roleFrameSent: boolean
): OpenAIStreamContext {
  if (roleFrameSent && context.provider !== "gateway") return context;
  return { ...context, id: final.id, model: final.model, provider: final.provider };
}

function errorFromChunk(chunk: { content: string; data?: GatewayError }): GatewayError {
  return (
    chunk.data ??
    new GatewayError("GatewayError", chunk.content || "The gateway failed to answer.", {
      category: "unknown",
    })
  );
}

function errorFromThrown(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError(
    "ProviderUnavailable",
    error instanceof Error && error.message
      ? error.message
      : "The gateway failed to answer.",
    { category: "temporary_upstream_failure" }
  );
}

/** Failures raised before a single byte is sent keep a real HTTP status. */
function preStreamError(error: unknown, requestId: string): Response {
  const gatewayError = errorFromThrown(error);
  const throttled = isRateLimitRejection(gatewayError);
  logGateway({
    requestId,
    event: throttled ? "rate_limited" : "failure",
    errorCategory: gatewayError.category,
    errorCode: gatewayError.code,
    note: "rejected before streaming started",
  });
  const { status, body } = errorResponse(gatewayError);
  return Response.json(body, {
    status,
    headers: {
      "X-NEXA-Request-Id": requestId,
      // A limiter refusal carries the standard retry hints: 429 for an
      // exhausted quota, 503 for a fail-closed store outage.
      ...(throttled ? rateLimitHeadersFor(gatewayError) : {}),
    },
  });
}
