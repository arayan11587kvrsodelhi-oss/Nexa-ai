/**
 * NEXA AI Gateway — external FreeLLMAPI provider adapter.
 *
 * The migration keeps the working external FreeLLMAPI installation available as
 * one provider among several (`ExternalFreeLLMAPIProvider`), so NEXA can move to
 * its own routing without a flag day. The adapter uses the existing, hardened
 * `FreeLLMAPIProvider` (a single `discoverCatalog()` call serves both health and
 * discovery, so the two are consistent and cost one request).
 *
 * Nothing here touches the FreeLLMAPI installation: it is an HTTP endpoint.
 */
import type { ModelProvider } from "@/lib/ai/types";
import {
  FreeLLMAPIProvider,
  type FreeLLMAPICatalog,
} from "@/lib/ai/providers/freellmapi";
import { validateProviderUrl } from "../config";
import type { AIProviderListOptions, GatewayProviderId, ModelInfo, ProviderHealth } from "../types";
import {
  LegacyBackedProvider,
  providerHealthFromIssue,
  type LegacyAdapterOptions,
} from "./legacy-adapter";
import { modelsFromIds, providerHealthFromConnection } from "./shared";

export class ExternalFreeLLMAPIProvider extends LegacyBackedProvider {
  public readonly id: GatewayProviderId = "freellmapi";
  public readonly name = "FreeLLMAPI (external)";
  public readonly requiresApiKey = false;
  protected readonly options: LegacyAdapterOptions = { streamingMode: "incremental" };
  public readonly baseUrl: string;

  /** One discovery call is reused for both `listModels` and `health`. */
  private cached: { at: number; catalog: FreeLLMAPICatalog } | null = null;

  constructor(
    baseUrl: string,
    private readonly apiKey?: string
  ) {
    super();
    this.baseUrl = baseUrl;
  }

  public override configurationIssue(): string | null {
    if (!this.baseUrl) {
      return "FREELLMAPI_BASE_URL is not set on the server, so the external gateway is disabled.";
    }
    const validation = validateProviderUrl(this.baseUrl, { label: "FreeLLMAPI base URL" });
    return validation.ok ? null : (validation.reason ?? "The FreeLLMAPI base URL is not usable.");
  }

  protected createAdapter(): ModelProvider {
    return new FreeLLMAPIProvider(this.baseUrl, this.apiKey);
  }

  /** `GET /v1/models`, reused within a short window so health == discovery. */
  public async discover(force = false): Promise<FreeLLMAPICatalog> {
    const now = Date.now();
    if (!force && this.cached && now - this.cached.at < 30_000) return this.cached.catalog;
    const adapter = new FreeLLMAPIProvider(this.baseUrl, this.apiKey);
    const catalog = await adapter.discoverCatalog();
    this.cached = { at: now, catalog };
    return catalog;
  }

  public override async listModels(options: AIProviderListOptions = {}): Promise<ModelInfo[]> {
    const issue = this.configurationIssue();
    if (issue) throw new Error(issue);
    if (options.cacheOnly) return [];
    const catalog = await this.discover();
    return modelsFromIds("freellmapi", catalog.models.map((m) => m.id), {
      requiresApiKey: false,
      supportsStreaming: true,
      // The provider-reported context windows travel with the models. Keeping
      // them here is what lets the registry report a real context length
      // instead of "not reported" for every model.
      contextLengths: Object.fromEntries(
        catalog.models
          .filter((m) => m.contextWindow !== null)
          .map((m) => [m.id, m.contextWindow as number])
      ),
      metadata: {
        adapterStreaming: this.options.streamingMode,
        externalGateway: true,
        contextWindows: Object.fromEntries(
          catalog.models
            .filter((m) => m.contextWindow !== null)
            .map((m) => [m.id, m.contextWindow as number])
        ),
      },
    });
  }

  /**
   * Health from the same discovery call. The external gateway answers with a
   * classified status, which is mapped — never upgraded.
   */
  public override async health(options: AIProviderListOptions = {}): Promise<ProviderHealth> {
    const issue = this.configurationIssue();
    if (issue) return providerHealthFromIssue(this.id, issue);
    if (options.cacheOnly) return providerHealthFromIssue(this.id, "not probed");
    const catalog = await this.discover(options.signal !== undefined);
    if (!catalog.configured) return providerHealthFromIssue(this.id, catalog.health.message);
    return providerHealthFromConnection(this.id, catalog.health);
  }
}
