/**
 * NEXA AI Gateway — shared adapter helpers.
 *
 * The gateway does not re-implement proven wire code. The existing, hardened
 * NEXA adapters (`ollama`, `openai-compatible`, `freellmapi`) already own their
 * request construction, SSE/NDJSON parsing, timeouts and cancellation, so the
 * gateway adapters *wrap* them and add what the gateway needs:
 *
 *  - normalizing their errors into the NEXA error taxonomy,
 *  - normalizing their health result into the health vocabulary,
 *  - converting their callback streaming into `AsyncIterable<ChatChunk>`,
 *  - applying the single-append content rule so a snapshot-style upstream cannot
 *    repeat content.
 *
 * AI Horde is the one provider implemented natively in the gateway (see
 * `ai-horde.ts`).
 */
import {
  ProviderError as LegacyProviderError,
} from "@/lib/ai/provider-errors";
import type {
  GenerateOptions,
  ModelProvider,
  ProviderConnectionResult,
  StreamEvent,
} from "@/lib/ai/types";
import { ContentAccumulator } from "../content";
import { GatewayError, type GatewayErrorCategory, type GatewayErrorCode } from "../errors";
import type {
  ChatChunk,
  ChatRequest,
  ChatUsage,
  GatewayHealthStatus,
  GatewayProviderId,
  ModelInfo,
  ProviderHealth,
  RoutingMetadata,
} from "../types";
import { normalizeModel } from "../registry";
import { AsyncQueue } from "./queue";

/** Map a legacy provider error code onto the gateway category. */
function categoryFromLegacy(error: LegacyProviderError): GatewayErrorCategory {
  // A 404 from a chat endpoint means the model was not found, not a bad request.
  if (error.status === 404) return "invalid_model";
  switch (error.code) {
    case "unauthorized":
      return "authentication_failure";
    case "timeout":
      return "timeout";
    case "rate_limited":
      return "rate_limit";
    case "misconfigured":
      return "permanent_configuration_failure";
    case "invalid_request":
      return "invalid_request";
    case "aborted":
      return "cancelled";
    default:
      return "temporary_upstream_failure";
  }
}

const CODE_FOR_CATEGORY: Record<GatewayErrorCategory, GatewayErrorCode> = {
  authentication_failure: "ProviderAuthenticationError",
  timeout: "ProviderTimeout",
  rate_limit: "RateLimited",
  invalid_model: "ModelNotFound",
  invalid_request: "InvalidRequest",
  permanent_configuration_failure: "ProviderUnavailable",
  cancelled: "GatewayError",
  temporary_upstream_failure: "ProviderUnavailable",
  unknown: "ProviderUnavailable",
};

function looksLikeNetworkFailure(message: string): boolean {
  return (
    message.includes("fetch failed") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("EHOSTUNREACH") ||
    message.includes("ENETUNREACH") ||
    message.includes("ENOTFOUND") ||
    message.includes("EAI_AGAIN") ||
    message.includes("socket hang up")
  );
}

/**
 * Turn any thrown value from a provider adapter into a classified, sanitized
 * `GatewayError`. Idempotent: an existing `GatewayError` passes through.
 */
export function toGatewayError(
  provider: GatewayProviderId,
  error: unknown,
  options: { model?: string; userAborted?: boolean } = {}
): GatewayError {
  if (error instanceof GatewayError) return error;

  if (error instanceof LegacyProviderError) {
    const category = options.userAborted ? "cancelled" : categoryFromLegacy(error);
    return new GatewayError(CODE_FOR_CATEGORY[category], error.message, {
      category,
      provider,
      model: options.model,
      upstreamStatus: error.status,
      cause: error,
    });
  }

  if (options.userAborted) {
    return new GatewayError(
      "GatewayError",
      "The request was cancelled before the provider finished.",
      { category: "cancelled", provider, model: options.model, cause: error }
    );
  }

  const raw = error instanceof Error ? error.message : String(error ?? "");
  const timedOut =
    error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

  if (timedOut) {
    return new GatewayError("ProviderTimeout", `${provider} did not respond in time.`, {
      category: "timeout",
      provider,
      model: options.model,
      cause: error,
    });
  }
  if (looksLikeNetworkFailure(raw)) {
    return new GatewayError(
      "ProviderUnavailable",
      `${provider} is not reachable. Check the provider endpoint and whether the service is running.`,
      { category: "temporary_upstream_failure", provider, model: options.model, cause: error }
    );
  }
  return new GatewayError(
    "ProviderUnavailable",
    `${provider} request failed: ${raw.slice(0, 200) || "unknown provider error"}.`,
    { category: "temporary_upstream_failure", provider, model: options.model, cause: error }
  );
}

/** Legacy health status → gateway health vocabulary. */
export function healthStatusFromConnection(result: ProviderConnectionResult): GatewayHealthStatus {
  if (result.ok) return "healthy";
  switch (result.status) {
    case "timeout":
      return "timeout";
    case "rate_limited":
      return "rate_limited";
    case "unauthorized":
      return "authentication_error";
    default:
      return "unavailable";
  }
}

function categoryFromHealthStatus(status: GatewayHealthStatus): GatewayErrorCategory {
  switch (status) {
    case "timeout":
      return "timeout";
    case "rate_limited":
      return "rate_limit";
    case "authentication_error":
      return "authentication_failure";
    case "unavailable":
      return "permanent_configuration_failure";
    default:
      return "temporary_upstream_failure";
  }
}

export function providerHealthFromConnection(
  provider: GatewayProviderId,
  result: ProviderConnectionResult
): ProviderHealth {
  const status = healthStatusFromConnection(result);
  return {
    provider,
    status,
    ok: status === "healthy",
    message: result.message,
    latencyMs: result.latencyMs ?? 0,
    ...(result.models ? { models: result.models } : {}),
    checkedAt: new Date().toISOString(),
    ...(status === "healthy" ? {} : { errorCategory: categoryFromHealthStatus(status) }),
  };
}

/** ChatRequest → the legacy adapter's option object. */
export function toGenerateOptions(request: ChatRequest, model: string): GenerateOptions {
  return {
    model,
    messages: request.messages,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { topP: request.topP } : {}),
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  };
}

/** Honest usage accounting: estimated and flagged as such. */
export function estimateUsage(messages: ChatRequest["messages"], completion: string): ChatUsage {
  const promptChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
  const completionTokens = Math.max(1, Math.ceil(completion.length / 4));
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

export function newCompletionId(): string {
  return `chatcmpl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Minimal routing metadata for a direct provider call.
 *
 * The gateway always replaces this with the real decision (candidates,
 * attempts, fallback) before the response reaches a client; providers need a
 * value they can attach without knowing the router.
 */
export function placeholderRouting(
  provider: GatewayProviderId,
  model: string,
  requestedModel: string
): RoutingMetadata {
  return {
    requestedModel,
    selectedProvider: provider,
    selectedModel: model,
    strategy: !requestedModel || requestedModel === "auto" ? "auto" : "explicit",
    reason: "The provider adapter executed this request directly.",
    candidates: [{ provider, model, reason: "adapter-direct" }],
    attempts: [],
    fallbackUsed: false,
  };
}

/**
 * Bridge a legacy adapter's callback streaming into gateway chunks.
 *
 * Content is folded through `ContentAccumulator`, so a provider that repeats
 * the whole reply in every frame contributes it exactly once. Action events are
 * forwarded as actions and are never turned into tokens.
 */
export async function* bridgeLegacyStream(
  provider: GatewayProviderId,
  adapter: ModelProvider,
  request: ChatRequest,
  model: string,
  routing: () => RoutingMetadata
): AsyncIterable<ChatChunk> {
  const queue = new AsyncQueue<ChatChunk>();
  const accumulator = new ContentAccumulator();
  const startedAt = Date.now();

  const emit = (event: StreamEvent) => {
    if (event.type === "token" && event.content) {
      // Forward `emitted`, not the raw chunk: for a snapshot frame that is the
      // new suffix only. Forwarding the snapshot itself would re-send text the
      // client already rendered — the duplicated-paragraph defect.
      const result = accumulator.appendToken(event.content);
      if (result.emitted) queue.push({ type: "token", content: result.emitted });
      return;
    }
    if (event.type === "reasoning" && event.content) {
      const result = accumulator.appendReasoning(event.content);
      if (result.emitted) queue.push({ type: "reasoning", content: result.emitted });
      return;
    }
    if (event.type === "action" && event.content) {
      // Action events are status text: they are never converted into tokens.
      queue.push({ type: "action", content: event.content });
      return;
    }
    if (event.type === "tool_call" && event.content) {
      queue.push({ type: "action", content: event.content });
    }
  };

  const run = (async () => {
    try {
      const result = await adapter.generateStream(toGenerateOptions(request, model), emit);
      queue.push({
        type: "done",
        data: {
          id: newCompletionId(),
          model,
          provider,
          // `fullText` is the provider's own echo of the whole reply. When the
          // upstream sends cumulative snapshots, that echo *also* contains the
          // earlier frames, so trusting it verbatim would put "HelloHello
          // world" in `done.content` even though the tokens were delivered
          // correctly. The accumulator is the authority on what was delivered.
          content: accumulator.text || result.fullText,
          ...(result.reasoningText ? { reasoning: result.reasoningText } : {}),
          finishReason: "stop",
          usage: estimateUsage(request.messages, result.fullText),
          latencyMs: Date.now() - startedAt,
          createdAt: Math.floor(Date.now() / 1000),
          routing: routing(),
        },
      });
    } catch (err) {
      queue.fail(
        toGatewayError(provider, err, { model, userAborted: request.signal?.aborted === true })
      );
    } finally {
      queue.close();
    }
  })();

  try {
    yield* queue;
  } finally {
    await run.catch(() => undefined);
  }
}

/** Build normalized `ModelInfo` entries from plain provider-reported ids. */
export function modelsFromIds(
  provider: GatewayProviderId,
  ids: string[],
  options: {
    requiresApiKey: boolean;
    supportsStreaming: boolean | null;
    metadata?: Record<string, unknown>;
    /** Provider-reported context window per model id, when it reported one. */
    contextLengths?: Record<string, number>;
  }
): ModelInfo[] {
  const discoveredAt = new Date().toISOString();
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const rawId of ids) {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const reported = options.contextLengths?.[id];
    // Only a positive number is a context window. A reported 0, a negative, or
    // a NaN is nonsense that must never be advertised as a real limit; such
    // values stay null, exactly as `firstPositiveNumber` decides upstream.
    const contextLength =
      typeof reported === "number" && Number.isFinite(reported) && reported > 0
        ? Math.trunc(reported)
        : undefined;
    models.push(
      normalizeModel({
        id,
        provider,
        requiresApiKey: options.requiresApiKey,
        supportsStreaming: options.supportsStreaming,
        // Only a number the provider actually reported; never a default.
        ...(contextLength !== undefined ? { contextLength } : {}),
        metadata: options.metadata ?? {},
        discoveredAt,
      })
    );
  }
  return models;
}
