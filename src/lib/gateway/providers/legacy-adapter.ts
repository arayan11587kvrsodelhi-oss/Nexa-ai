/**
 * NEXA AI Gateway — legacy-adapter base class.
 *
 * Ollama, the generic OpenAI-compatible endpoint, and the external FreeLLMAPI
 * are already implemented — and already hardened (bounded timeouts, abort
 * propagation, SSE/NDJSON framing, credential redaction) — as `ModelProvider`s.
 * The gateway does not rewrite them. This class adapts one to the gateway
 * contract in a single place, so the three provider files stay tiny.
 *
 * Adapters here are *observers*: they return structured results and never touch
 * the health store. Recording health is the gateway's job, so there is exactly
 * one place that decides whether a provider is healthy.
 */
import type { ModelProvider } from "@/lib/ai/types";
import { ContentAccumulator } from "../content";
import { GatewayError } from "../errors";
import type {
  AIProvider,
  AIProviderListOptions,
  ChatChunk,
  ChatRequest,
  ChatResponse,
  GatewayProviderId,
  ModelInfo,
  ProviderHealth,
} from "../types";
import {
  bridgeLegacyStream,
  modelsFromIds,
  placeholderRouting,
  providerHealthFromConnection,
} from "./shared";

export interface LegacyAdapterOptions {
  /**
   * How the *adapter* delivers text. `incremental` means it emits events as
   * they arrive; `blocking` means the upstream answers in one body and the
   * adapter re-frames it. Recorded in model metadata, never presented as a
   * claim about the model.
   */
  readonly streamingMode: "incremental" | "blocking";
}

export abstract class LegacyBackedProvider implements AIProvider {
  public abstract readonly id: GatewayProviderId;
  public abstract readonly name: string;
  public abstract readonly requiresApiKey: boolean;
  public abstract readonly baseUrl: string;
  protected abstract readonly options: LegacyAdapterOptions;

  /** Build the underlying legacy adapter for one operation. */
  protected abstract createAdapter(): ModelProvider;

  /** Null (usable) or an operator-facing explanation. Defaults to usable. */
  public configurationIssue(): string | null {
    return null;
  }

  public isConfigured(): boolean {
    return this.configurationIssue() === null;
  }

  /**
   * Models the provider itself reported.
   *
   * Deliberately makes **no** health claim: the legacy adapters answer `[]`
   * both for "no models" and for "the endpoint did not answer", and those must
   * not look the same to the router. `health()` is the only probe.
   */
  public async listModels(options: AIProviderListOptions = {}): Promise<ModelInfo[]> {
    const issue = this.configurationIssue();
    if (issue) throw this.misconfigured(issue);
    if (options.cacheOnly) return [];
    const ids = await this.createAdapter().listModels();
    return modelsFromIds(this.id, ids, {
      requiresApiKey: this.requiresApiKey,
      supportsStreaming: true,
      metadata: { adapterStreaming: this.options.streamingMode },
    });
  }

  /** A real reachability probe. Never reports healthy without an observation. */
  public async health(options: AIProviderListOptions = {}): Promise<ProviderHealth> {
    const issue = this.configurationIssue();
    if (issue) return providerHealthFromIssue(this.id, issue);
    if (options.cacheOnly) return providerHealthFromIssue(this.id, "not probed");
    return providerHealthFromConnection(this.id, await this.createAdapter().testConnection());
  }

  /** Non-streaming call, implemented on top of the streaming one. */
  public async chat(request: ChatRequest): Promise<ChatResponse> {
    let done: ChatResponse | null = null;
    const accumulator = new ContentAccumulator();
    for await (const chunk of this.streamChat({ ...request, stream: false })) {
      if (chunk.type === "token") accumulator.appendToken(chunk.content);
      if (chunk.type === "done") done = chunk.data;
    }
    if (!done) {
      throw this.misconfigured("The provider ended the stream without a completion.");
    }
    return { ...done, content: done.content || accumulator.text };
  }

  public streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
    const issue = this.configurationIssue();
    const model = (request.model ?? "").trim();
    if (issue) return failingStream(this.misconfigured(issue));
    if (!model) {
      return failingStream(
        this.misconfigured(
          "No model was selected for this provider. Discover models via GET /v1/models, or pin one with `provider/model`."
        )
      );
    }
    const adapter = this.createAdapter();
    const routing = () => placeholderRouting(this.id, model, request.model);
    return bridgeLegacyStream(this.id, adapter, request, model, routing);
  }

  private misconfigured(message: string): GatewayError {
    return new GatewayError("ProviderUnavailable", message, {
      category: "permanent_configuration_failure",
      provider: this.id,
    });
  }
}

/** Health result for a provider that has not been (or cannot be) probed. */
export function providerHealthFromIssue(
  provider: GatewayProviderId,
  message: string
): ProviderHealth {
  return {
    provider,
    status: "unavailable",
    ok: false,
    message,
    latencyMs: 0,
    checkedAt: new Date().toISOString(),
    errorCategory: "permanent_configuration_failure",
  };
}

async function* failingStream(error: GatewayError): AsyncIterable<ChatChunk> {
  yield { type: "error", content: error.message, data: error };
}
