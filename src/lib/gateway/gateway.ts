/**
 * NEXA AI Gateway — orchestrator.
 *
 * The one place that answers "which provider/model served this request, what was
 * tried, and what did it cost". Everything above it (NEXA's own `/api/chat` and
 * the public OpenAI-compatible `/v1/*` surface) talks to this class only.
 *
 * Guarantees it enforces:
 *
 *  - `auto` is routed by NEXA (`GatewayRouter`), never delegated upwards.
 *  - Retries and fallback are bounded (`runWithFallback`) and only ever happen
 *    for transient failures.
 *  - Once real content has been delivered, the gateway never falls back: a
 *    second provider would duplicate the answer. It reports the failure instead.
 *  - A completion with no content is treated as a provider failure, so an
 *    unavailable model cannot silently produce an empty answer.
 *  - Every observation is recorded in the health store and every request is
 *    logged with request id, provider, model, latency and error category.
 */
import { GatewayError } from "./errors";
import { GatewayHealthStore, type HealthRecord } from "./health";
import { logGateway, newRequestId, summarizeMessages } from "./logging";
import { createConfiguredProviders, type ProviderOverrides } from "./providers/factory";
import { modelsFromIds, newCompletionId } from "./providers/shared";
import { GatewayModelRegistry, type RegistrySnapshot } from "./registry";
import { GatewayRouter, type RoutePlan } from "./router";
import { runWithFallback, type AttemptTarget } from "./retry";
import type {
  AIProvider,
  ChatChunk,
  ChatRequest,
  ChatResponse,
  GatewayHealthStatus,
  GatewayProviderId,
  ModelInfo,
  ProviderHealth,
  RoutingAttempt,
  RoutingMetadata,
} from "./types";

export interface GatewayHealthReport {
  ok: boolean;
  /** Worst provider status, so a single glance stays honest. */
  status: GatewayHealthStatus;
  message: string;
  checkedAt: string;
  providers: ProviderHealth[];
  models: {
    total: number;
    available: number;
    unknown: number;
    unavailable: number;
  };
  /** Deterministic provider order that `auto` routing will use. */
  providerOrder: GatewayProviderId[];
  healthRecords: HealthRecord[];
}

export type GatewayProviderConfigList = ReturnType<typeof createConfiguredProviders>["configs"];

export interface GatewayContext {
  providers: AIProvider[];
  configs: GatewayProviderConfigList;
  byId: Map<GatewayProviderId, AIProvider>;
}

export class NexaGateway {
  /** Providers + configs + a lookup map for the current environment. */
  public static context(overrides: ProviderOverrides = {}): GatewayContext {
    const { providers, configs } = createConfiguredProviders(overrides);
    return { providers, configs, byId: new Map(providers.map((p) => [p.id, p])) };
  }

  /**
   * Discover models for every configured provider.
   *
   * Also hydrates the health store once per process, so a cold instance starts
   * from recent durable observations instead of an optimistic blank slate.
   */
  public static async refresh(
    options: { force?: boolean; signal?: AbortSignal; overrides?: ProviderOverrides } = {}
  ): Promise<RegistrySnapshot> {
    await GatewayHealthStore.hydrate();
    const { providers } = this.context(options.overrides);
    return GatewayModelRegistry.refresh(providers, {
      force: options.force === true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  public static async listModels(
    options: { refresh?: boolean; signal?: AbortSignal; overrides?: ProviderOverrides } = {}
  ): Promise<ModelInfo[]> {
    await this.refresh({
      force: options.refresh === true,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.overrides ? { overrides: options.overrides } : {}),
    });
    return GatewayModelRegistry.allModels();
  }

  /** Probe every configured provider for real and report what was observed. */
  public static async health(
    options: { signal?: AbortSignal; overrides?: ProviderOverrides } = {}
  ): Promise<GatewayHealthReport> {
    await GatewayHealthStore.hydrate();
    const { providers, configs } = this.context(options.overrides);
    const results: ProviderHealth[] = [];

    await Promise.all(
      providers.map(async (provider) => {
        const started = Date.now();
        const health = await provider
          .health(options.signal ? { signal: options.signal } : {})
          .catch(
            (error: unknown): ProviderHealth => ({
              provider: provider.id,
              status: "unavailable",
              ok: false,
              message: error instanceof Error ? error.message : "Provider probe failed.",
              latencyMs: Date.now() - started,
              checkedAt: new Date().toISOString(),
            })
          );
        results.push(health);
        GatewayModelRegistry.setProviderHealth(health);
        // The probe already returned the ids the provider reported, so a cold
        // process that has never listed models can still count them. Without
        // this the report said "none reported a model" while `providers[].models`
        // listed 24 of them.
        //
        // It only ever *fills a gap*. `listModels()` carries capability detail
        // (context window, streaming mode) that a bare id list does not, so
        // overwriting it would downgrade honest data to "not reported".
        if (
          health.ok &&
          health.models?.length &&
          GatewayModelRegistry.modelsFor(provider.id).length === 0
        ) {
          GatewayModelRegistry.seedModelsFromHealth(
            provider.id,
            modelsFromIds(provider.id, health.models, {
              requiresApiKey: provider.requiresApiKey,
              supportsStreaming: null,
            })
          );
        }
        await this.recordProbe(provider.id, health);
      })
    );

    // Disabled providers are reported too, with the operator-facing reason.
    for (const config of configs.filter((entry) => !entry.enabled)) {
      results.push({
        provider: config.id,
        status: "configured",
        ok: false,
        message: config.note,
        latencyMs: 0,
        checkedAt: new Date().toISOString(),
      });
    }

    const models = GatewayModelRegistry.allModels();
    const counts = {
      total: models.length,
      available: models.filter((m) => m.availability === "available").length,
      unknown: models.filter((m) => m.availability === "unknown").length,
      unavailable: models.filter(
        (m) => m.availability !== "available" && m.availability !== "unknown"
      ).length,
    };
    const failed = results.filter((entry) => !entry.ok);
    // `ok` answers the only question a load balancer actually asks: can this
    // instance serve a request? It is NOT "every configured provider is up" —
    // a gateway with one healthy provider and one unreachable optional provider
    // is fully operational, and reporting it as 503 would take a serving
    // instance out of rotation. Per-provider truth stays in `providers[]`.
    const routable = results.filter((entry) => entry.ok && (entry.models?.length ?? 0) > 0);
    const status: GatewayHealthStatus =
      results.length === 0
        ? "unavailable"
        : routable.length === 0
          ? failed.length === results.length
            ? "unavailable"
            : "provider_error"
          : failed.length === 0
            ? "healthy"
            : "provider_error";

    return {
      ok: routable.length > 0,
      status,
      message:
        results.length === 0
          ? "No provider is configured. Set a provider endpoint to enable the gateway."
          : counts.total === 0
            ? "Providers are configured but none reported a model."
            : routable.length === 0
              ? `No provider currently has a usable model. ${counts.total} model(s) are known, but every provider that reported one is unhealthy.`
              : failed.length === 0
                ? `${counts.total} model(s) known: ${counts.available} observed healthy, ${counts.unknown} not yet observed, ${counts.unavailable} unhealthy.`
                : `${counts.total} model(s) known; ${routable.length} provider(s) serving, ${failed.length} unhealthy.`,
      checkedAt: new Date().toISOString(),
      providers: results.sort((a, b) => a.provider.localeCompare(b.provider)),
      models: counts,
      providerOrder: configs.filter((c) => c.enabled).map((c) => c.id),
      healthRecords: GatewayHealthStore.snapshot(),
    };
  }

  /** The routing decision `auto` would take for a prompt/model, for diagnostics. */
  public static async previewRoute(input: {
    model?: string;
    stream?: boolean;
    overrides?: ProviderOverrides;
  }): Promise<{ plan: RoutePlan; modelsKnown: number }> {
    await this.refresh(input.overrides ? { overrides: input.overrides } : {});
    const { providers, configs } = this.context(input.overrides);
    const plan = GatewayRouter.plan({
      requestedModel: input.model ?? "auto",
      stream: input.stream !== false,
      providers,
      configs,
    });
    return { plan, modelsKnown: GatewayModelRegistry.allModels().length };
  }

  /**
   * Non-streaming completion, with bounded retry and fallback.
   *
   * An empty completion is a failure: trying the next eligible model is more
   * honest than returning blank text from a model that did not answer.
   */
  public static async chat(request: ChatRequest): Promise<ChatResponse> {
    const requestId = request.requestId ?? newRequestId();
    const started = Date.now();
    const { plan, context } = await this.prepare(request, requestId);

    const result = await runWithFallback(
      toTargets(plan),
      async (target) => {
        const provider = requireProvider(context, target);
        const response = await provider.chat({
          ...request,
          model: target.model,
          stream: false,
          requestId,
        });
        assertNonEmpty(response, target);
        return response;
      },
      {
        ...(request.signal ? { signal: request.signal } : {}),
        onAttemptFailure: (input) => this.recordFailure(input.target, input.error),
        onFallback: (input) =>
          Promise.resolve(
            logGateway({
              requestId,
              event: "fallback",
              provider: input.to.provider,
              model: input.to.model,
              errorCategory: input.error.category,
              note: `falling back from ${input.from.provider}/${input.from.model}`,
            })
          ),
      }
    );

    const routing = buildRouting(plan, result.target, result.attempts);
    const response = { ...result.value, routing };
    await this.recordSuccess(result.target, Date.now() - started);
    logGateway({
      requestId,
      event: "success",
      provider: result.target.provider,
      model: result.target.model,
      strategy: plan.strategy,
      latencyMs: Date.now() - started,
      attempts: result.attempts.length,
      fallbackUsed: result.fallbackUsed,
      request: summarizeMessages(request.messages),
    });
    return response;
  }

  /**
   * Streaming completion.
   *
   * Real streaming is preserved: the first non-empty token is delivered
   * immediately. What is deliberately **not** done is falling back after content
   * has been delivered — that would duplicate the answer, which is exactly the
   * defect this migration removes.
   */
  public static async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
    const requestId = request.requestId ?? newRequestId();
    const started = Date.now();
    const { plan, context } = await this.prepare(request, requestId);

    yield { type: "action", content: `NEXA gateway: ${plan.reason}` };

    const targets = toTargets(plan);
    const attempts: RoutingAttempt[] = [];
    let lastError: GatewayError | null = null;

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      if (request.signal?.aborted) {
        yield cancelledChunk(target);
        return;
      }
      if (index > 0 && lastError) {
        yield {
          type: "action",
          content: `Falling back to ${target.provider}/${target.model} after a ${lastError.category} failure.`,
        };
      }

      const provider = context.byId.get(target.provider);
      if (!provider) {
        lastError = new GatewayError(
          "ProviderUnavailable",
          `Provider '${target.provider}' is not configured.`,
          { category: "permanent_configuration_failure", provider: target.provider }
        );
        break;
      }

      const attemptStart = Date.now();
      const preCommit: ChatChunk[] = [];
      let committed = false;
      let failure: GatewayError | null = null;
      let doneChunk: Extract<ChatChunk, { type: "done" }> | null = null;

      try {
        for await (const chunk of provider.streamChat({
          ...request,
          model: target.model,
          stream: true,
          requestId,
        })) {
          if (!committed) {
            if (chunk.type === "error") {
              failure = asGatewayError(chunk.data ?? new Error(chunk.content), target);
              break;
            }
            if (chunk.type === "done") {
              doneChunk = chunk;
              break;
            }
            // Empty token/reasoning frames must never count as content.
            const hasContent =
              (chunk.type === "token" || chunk.type === "reasoning") &&
              chunk.content.trim().length > 0;
            if (!hasContent) {
              preCommit.push(chunk);
              continue;
            }
            committed = true;
            for (const buffered of preCommit.splice(0)) yield buffered;
            yield chunk;
            continue;
          }

          if (chunk.type === "done") {
            doneChunk = chunk;
            break;
          }
          if (chunk.type === "error") {
            failure = asGatewayError(chunk.data ?? new Error(chunk.content), target);
            break;
          }
          // Empty events are dropped: they must never create content or Markdown.
          if ((chunk.type === "token" || chunk.type === "reasoning") && !chunk.content) continue;
          yield chunk;
        }
      } catch (error) {
        failure = asGatewayError(error, target, request.signal?.aborted === true);
      }

      // A stream that produced nothing is a failure, whatever the provider said.
      if (!failure && !committed) {
        failure = emptyCompletionError(target);
      }
      if (!failure && doneChunk && !committed && doneChunk.data.content.trim().length === 0) {
        failure = emptyCompletionError(target);
      }

      if (!failure) {
        attempts.push({
          provider: target.provider,
          model: target.model,
          outcome: "success",
          latencyMs: Date.now() - attemptStart,
        });
        const routing = buildRouting(plan, target, attempts);
        yield {
          type: "done",
          data: {
            ...(doneChunk?.data ?? {
              id: newCompletionId(),
              model: target.model,
              provider: target.provider,
              content: "",
              finishReason: "stop" as const,
              usage: null,
              latencyMs: Date.now() - started,
              createdAt: Math.floor(Date.now() / 1000),
            }),
            routing,
          },
        };
        await this.recordSuccess(target, Date.now() - started);
        logGateway({
          requestId,
          event: "success",
          provider: target.provider,
          model: target.model,
          strategy: plan.strategy,
          latencyMs: Date.now() - started,
          attempts: attempts.length,
          fallbackUsed: attempts.some((entry) => entry.outcome !== "success"),
          request: summarizeMessages(request.messages),
        });
        return;
      }

      attempts.push({
        provider: target.provider,
        model: target.model,
        outcome: "failed",
        errorCategory: failure.category,
        latencyMs: Date.now() - attemptStart,
      });
      await this.recordFailure(target, failure);
      lastError = failure;

      logGateway({
        requestId,
        event: "failure",
        provider: target.provider,
        model: target.model,
        errorCategory: failure.category,
        errorCode: failure.code,
        attempts: attempts.length,
        note: committed ? "failed after content was delivered; no fallback attempted" : undefined,
      });

      if (committed || !failure.canFallback) {
        yield { type: "error", content: failure.message, data: failure };
        return;
      }
    }

    const finalError = lastError ?? noProviderError();
    yield { type: "error", content: finalError.message, data: finalError };
  }

  /**
   * Discovery + routing for one request.
   *
   * Fails fast with a clear error when nothing is configured, instead of
   * pretending a provider exists.
   */
  private static async prepare(
    request: ChatRequest,
    requestId: string
  ): Promise<{ plan: RoutePlan; context: GatewayContext }> {
    const context = this.context();
    await GatewayHealthStore.hydrate();
    await GatewayModelRegistry.refresh(context.providers, {
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (context.providers.length === 0) {
      logGateway({
        requestId,
        event: "failure",
        errorCategory: "permanent_configuration_failure",
        errorCode: "ProviderUnavailable",
        note: "no provider is configured",
      });
      throw new GatewayError(
        "ProviderUnavailable",
        "No AI provider is configured for the NEXA gateway. Set a provider endpoint such as FREELLMAPI_BASE_URL, OLLAMA_BASE_URL or OPENAI_COMPATIBLE_BASE_URL (plus AI_HORDE_ENABLED=true for AI Horde).",
        { category: "permanent_configuration_failure", provider: "gateway" }
      );
    }

    const plan = GatewayRouter.plan({
      requestedModel: request.model,
      stream: request.stream,
      providers: context.providers,
      configs: context.configs,
    });

    logGateway({
      requestId,
      event: "chat_request",
      provider: plan.candidates[0]?.provider,
      model: plan.candidates[0]?.model,
      strategy: plan.strategy,
      request: summarizeMessages(request.messages),
      note: `candidates=${plan.candidates.length} excluded=${plan.excluded.length}`,
    });

    return { plan, context };
  }

  /** Record a real probe result. `configured` is not a health claim. */
  private static async recordProbe(
    provider: GatewayProviderId,
    health: ProviderHealth
  ): Promise<void> {
    if (health.ok) {
      await GatewayHealthStore.recordSuccess({
        provider,
        latencyMs: health.latencyMs,
        message: health.message,
      });
      return;
    }
    if (health.status === "configured") return;
    await GatewayHealthStore.recordError({
      provider,
      error: new GatewayError("ProviderUnavailable", health.message, {
        category: health.errorCategory ?? "temporary_upstream_failure",
        provider,
      }),
      latencyMs: health.latencyMs,
    });
  }

  /**
   * Record a failed attempt.
   *
   * Model-scoped for model problems, provider-scoped for authentication
   * failures — which are never a property of one model.
   */
  private static async recordFailure(target: AttemptTarget, error: GatewayError): Promise<void> {
    if (error.category === "invalid_model") {
      await GatewayHealthStore.recordInvalidModel(target.provider, target.model, error.message);
      return;
    }
    await GatewayHealthStore.recordError({
      provider: target.provider,
      modelId: target.model,
      error,
    });
    if (error.category === "authentication_failure") {
      await GatewayHealthStore.recordError({
        provider: target.provider,
        modelId: null,
        error,
      });
    }
  }

  private static async recordSuccess(target: AttemptTarget, latencyMs: number): Promise<void> {
    await GatewayHealthStore.recordSuccess({
      provider: target.provider,
      modelId: target.model,
      latencyMs,
    });
    await GatewayHealthStore.recordSuccess({ provider: target.provider, latencyMs });
  }
}

function toTargets(plan: RoutePlan): AttemptTarget[] {
  return plan.candidates.map((candidate) => ({
    provider: candidate.provider,
    model: candidate.model,
  }));
}

function requireProvider(context: GatewayContext, target: AttemptTarget): AIProvider {
  const provider = context.byId.get(target.provider);
  if (!provider) {
    throw new GatewayError("ProviderUnavailable", `Provider '${target.provider}' is not configured.`, {
      category: "permanent_configuration_failure",
      provider: target.provider,
    });
  }
  return provider;
}

/** An empty completion is a failure, not an answer. */
function assertNonEmpty(response: ChatResponse, target: AttemptTarget): void {
  const hasContent =
    response.content.trim().length > 0 || (response.reasoning ?? "").trim().length > 0;
  if (!hasContent) throw emptyCompletionError(target);
}

function emptyCompletionError(target: AttemptTarget): GatewayError {
  return new GatewayError("ModelUnavailable", `${target.provider}/${target.model} returned no content.`, {
    category: "temporary_upstream_failure",
    provider: target.provider,
    model: target.model,
  });
}

function noProviderError(): GatewayError {
  return new GatewayError(
    "ProviderUnavailable",
    "No eligible provider could serve this request.",
    { category: "temporary_upstream_failure", provider: "gateway" }
  );
}

function cancelledChunk(target: AttemptTarget): ChatChunk {
  const error = new GatewayError("GatewayError", "The request was cancelled.", {
    category: "cancelled",
    provider: target.provider,
    model: target.model,
  });
  return { type: "error", content: error.message, data: error };
}

/** Normalize a thrown value into a classified gateway error. */
function asGatewayError(error: unknown, target: AttemptTarget, aborted = false): GatewayError {
  if (error instanceof GatewayError) return error;
  if (aborted) {
    return new GatewayError("GatewayError", "The request was cancelled.", {
      category: "cancelled",
      provider: target.provider,
      model: target.model,
      cause: error,
    });
  }
  return new GatewayError(
    "ProviderUnavailable",
    error instanceof Error && error.message
      ? error.message
      : `The provider '${target.provider}' failed to answer.`,
    {
      category: "temporary_upstream_failure",
      provider: target.provider,
      model: target.model,
      cause: error,
    }
  );
}

/** The routing record returned to clients: what was chosen and what was tried. */
function buildRouting(
  plan: RoutePlan,
  target: AttemptTarget,
  attempts: RoutingAttempt[]
): RoutingMetadata {
  return {
    requestedModel: plan.requestedModel,
    selectedProvider: target.provider,
    selectedModel: target.model,
    strategy: plan.strategy,
    reason:
      plan.candidates.find(
        (candidate) => candidate.provider === target.provider && candidate.model === target.model
      )?.reason ?? plan.reason,
    candidates: plan.candidates.map((candidate) => ({
      provider: candidate.provider,
      model: candidate.model,
      reason: candidate.reason,
    })),
    attempts,
    fallbackUsed: attempts.some((entry) => entry.outcome !== "success"),
  };
}
