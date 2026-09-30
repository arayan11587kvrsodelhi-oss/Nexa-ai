/**
 * NEXA AI Gateway — model registry.
 *
 * One normalized catalogue, filled from what providers *actually report*.
 *
 * Honesty rules enforced here (not in the UI):
 *
 *  - A capability the provider did not report stays `null`. Nothing is inferred
 *    from a model name, and no model gets an invented context window.
 *  - `availability` is derived from recorded health, never from presence in a
 *    list. A discovered model with no observation is `unknown`, not `available`.
 *  - Discovery is cached in-process with a short TTL so a request does not fan
 *    out to every provider, but a cache hit never upgrades a model's health.
 */
import type { AIProvider, GatewayProviderId, ModelInfo, ProviderHealth } from "./types";
import { GatewayHealthStore, statusFromErrorCategory } from "./health";
import { findProviderConfig } from "./config";

export interface RegistrySnapshot {
  models: ModelInfo[];
  providers: ProviderHealth[];
  /** ISO timestamp of the discovery pass that produced this snapshot. */
  refreshedAt: string;
}

/** How long a discovery result may be reused before it is refreshed. */
export const DISCOVERY_TTL_MS = 60_000;

function availabilityFromHealth(
  provider: GatewayProviderId,
  modelId: string
): ModelInfo["availability"] {
  const record =
    GatewayHealthStore.get(provider, modelId) ?? GatewayHealthStore.get(provider, null);
  if (!record) return "unknown";
  if (record.ok) return "available";
  switch (record.status) {
    case "timeout":
      return "timeout";
    case "rate_limited":
      return "rate_limited";
    case "authentication_error":
      return "authentication_error";
    case "provider_error":
      return "provider_error";
    default:
      return "unavailable";
  }
}

export class GatewayModelRegistry {
  private static byProvider = new Map<GatewayProviderId, ModelInfo[]>();
  private static searchedAt = new Map<GatewayProviderId, number>();
  private static providerHealthMap = new Map<GatewayProviderId, ProviderHealth>();

  public static reset(): void {
    this.byProvider.clear();
    this.searchedAt.clear();
    this.providerHealthMap.clear();
  }

  /** Record the models a provider reported. Never invents extra entries. */
  public static setModels(provider: GatewayProviderId, models: ModelInfo[]): void {
    this.storeModels(provider, models);
    // A real discovery pass happened, so the catalogue is fresh.
    this.searchedAt.set(provider, Date.now());
  }

  /**
   * Record a bare model-id list learned from a health probe.
   *
   * Deliberately does NOT mark the catalogue fresh: a health probe returns ids
   * only, with no capability detail, so treating it as a completed discovery
   * would suppress the real `listModels()` call (and its context windows and
   * streaming mode) for the whole discovery TTL.
   */
  public static seedModelsFromHealth(
    provider: GatewayProviderId,
    models: ModelInfo[]
  ): void {
    this.storeModels(provider, models);
  }

  private static storeModels(provider: GatewayProviderId, models: ModelInfo[]): void {
    const deduped = new Map<string, ModelInfo>();
    for (const model of models) {
      if (model.id) deduped.set(model.id, this.withLiveAvailability(model));
    }
    this.byProvider.set(
      provider,
      Array.from(deduped.values()).sort((a, b) => a.id.localeCompare(b.id))
    );
  }

  public static setProviderHealth(health: ProviderHealth): void {
    this.providerHealthMap.set(health.provider, health);
  }

  public static getProviderHealth(provider: GatewayProviderId): ProviderHealth | undefined {
    return this.providerHealthMap.get(provider);
  }

  public static allProviderHealth(): ProviderHealth[] {
    return Array.from(this.providerHealthMap.values());
  }

  public static modelsFor(provider: GatewayProviderId): ModelInfo[] {
    return (this.byProvider.get(provider) ?? []).map((m) => this.withLiveAvailability(m));
  }

  public static allModels(): ModelInfo[] {
    const all: ModelInfo[] = [];
    for (const provider of this.byProvider.keys()) all.push(...this.modelsFor(provider));
    return all;
  }

  public static find(provider: GatewayProviderId, modelId: string): ModelInfo | undefined {
    return this.modelsFor(provider).find((model) => model.id === modelId);
  }

  public static isFresh(provider: GatewayProviderId, ttlMs = DISCOVERY_TTL_MS): boolean {
    const at = this.searchedAt.get(provider);
    return typeof at === "number" && Date.now() - at < ttlMs;
  }

  /**
   * Discover models for each configured provider.
   *
   * A provider that fails discovery is recorded as unhealthy with its
   * classified status and contributes **no** models — a failed discovery must
   * never leave a stale catalogue claim in place.
   */
  public static async refresh(
    providers: AIProvider[],
    options: { signal?: AbortSignal; force?: boolean; ttlMs?: number } = {}
  ): Promise<RegistrySnapshot> {
    const ttl = options.ttlMs ?? DISCOVERY_TTL_MS;
    await Promise.all(
      providers.map(async (provider) => {
        const issue = provider.configurationIssue();
        if (issue) {
          this.providerHealthMap.set(provider.id, {
            provider: provider.id,
            status: "configured",
            ok: false,
            message: issue,
            latencyMs: 0,
            checkedAt: new Date().toISOString(),
          });
          this.byProvider.delete(provider.id);
          return;
        }
        if (!options.force && this.isFresh(provider.id, ttl)) return;

        const started = Date.now();
        try {
          const models = await provider.listModels({ signal: options.signal });
          this.setModels(provider.id, models);
          const health = await provider.health({ signal: options.signal, cacheOnly: true });
          this.setProviderHealth({ ...health, latencyMs: health.latencyMs || Date.now() - started });
        } catch (err) {
          const category = (err as { category?: Parameters<typeof statusFromErrorCategory>[0] })
            .category;
          this.byProvider.delete(provider.id);
          this.providerHealthMap.set(provider.id, {
            provider: provider.id,
            status: category ? statusFromErrorCategory(category) : "unavailable",
            ok: false,
            message: err instanceof Error ? err.message : "Model discovery failed.",
            latencyMs: Date.now() - started,
            checkedAt: new Date().toISOString(),
          });
        }
      })
    );

    return {
      models: this.allModels(),
      providers: this.allProviderHealth(),
      refreshedAt: new Date().toISOString(),
    };
  }

  /**
   * Provider-pinned reference, e.g. `aihorde/koboldcpp/Angelic_Eclipse-12B`.
   * Provider ids are a closed set, so the split is unambiguous even when the
   * model id itself contains slashes.
   */
  public static modelRef(provider: GatewayProviderId, modelId: string): string {
    return `${provider}/${modelId}`;
  }

  /** Split a pinned reference into provider + model. */
  public static parseModelRef(
    raw: string,
    known: readonly GatewayProviderId[]
  ): { provider?: GatewayProviderId; model: string } {
    const value = (raw ?? "").trim();
    for (const id of known) {
      if (value.toLowerCase().startsWith(`${id}/`)) {
        return { provider: id, model: value.slice(id.length + 1) };
      }
      if (value.toLowerCase().startsWith(`${id}:`)) {
        return { provider: id, model: value.slice(id.length + 1) };
      }
    }
    return { model: value };
  }

  /** OpenAI-compatible `GET /v1/models` projection. */
  public static toOpenAIModels(models?: ModelInfo[]): Array<Record<string, unknown>> {
    const list = models ?? this.allModels();
    return list.map((model) => ({
      id: model.id,
      object: "model",
      created: Math.floor(Date.parse(model.discoveredAt) / 1000) || 0,
      owned_by: model.provider,
      // NEXA extensions: explicit, never inferred.
      nexa_provider: model.provider,
      nexa_display_name: model.displayName,
      nexa_capabilities: model.capabilities,
      nexa_context_length: model.contextLength,
      nexa_streaming: model.streaming,
      nexa_availability: model.availability,
      nexa_requires_api_key: model.requiresApiKey,
      nexa_last_health_check: model.lastHealthCheck,
      nexa_pinned_id: this.modelRef(model.provider, model.id),
      nexa_metadata: model.metadata,
    }));
  }

  /** Refresh the per-model availability from the health store on every read. */
  private static withLiveAvailability(model: ModelInfo): ModelInfo {
    const record = GatewayHealthStore.get(model.provider, model.id);
    return {
      ...model,
      availability: availabilityFromHealth(model.provider, model.id),
      lastHealthCheck: record?.checkedAt ?? model.lastHealthCheck,
    };
  }
}

/** Build a normalized model entry from a provider-reported id. */
export function normalizeModel(input: {
  id: string;
  provider: GatewayProviderId;
  displayName?: string;
  contextLength?: number | null;
  supportsStreaming?: boolean | null;
  supportsTools?: boolean | null;
  supportsVision?: boolean | null;
  supportsEmbeddings?: boolean | null;
  ownedBy?: string;
  requiresApiKey?: boolean;
  metadata?: Record<string, unknown>;
  discoveredAt?: string;
}): ModelInfo {
  const streaming = input.supportsStreaming ?? null;
  return {
    id: input.id,
    displayName: input.displayName?.trim() || input.id,
    provider: input.provider,
    capabilities: {
      streaming,
      tools: input.supportsTools ?? null,
      vision: input.supportsVision ?? null,
      embeddings: input.supportsEmbeddings ?? null,
    },
    contextLength: input.contextLength ?? null,
    streaming,
    availability: "unknown",
    requiresApiKey: input.requiresApiKey ?? false,
    lastHealthCheck: null,
    ...(input.ownedBy ? { ownedBy: input.ownedBy } : {}),
    discoveredAt: input.discoveredAt ?? new Date().toISOString(),
    metadata: input.metadata ?? {},
  };
}

/** Provider-level configuration state, for diagnostics endpoints. */
export function providerConfiguration(provider: GatewayProviderId): {
  configured: boolean;
  note: string;
  baseUrl: string;
} {
  const config = findProviderConfig(provider);
  return { configured: config.enabled, note: config.note, baseUrl: config.baseUrl };
}

