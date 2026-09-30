/**
 * NEXA AI Gateway — generic OpenAI-compatible provider adapter.
 *
 * Wraps the existing `OpenAICompatibleProvider` (SSE against
 * `POST /chat/completions`, model list from `GET /models`), which covers
 * LM Studio, vLLM, llama.cpp servers, and any other OpenAI-shaped endpoint.
 */
import type { ModelProvider } from "@/lib/ai/types";
import { OpenAICompatibleProvider } from "@/lib/ai/providers/openai-compatible";
import { validateProviderUrl } from "../config";
import type { GatewayProviderId } from "../types";
import { LegacyBackedProvider, type LegacyAdapterOptions } from "./legacy-adapter";

export class OpenAICompatibleGatewayProvider extends LegacyBackedProvider {
  public readonly requiresApiKey = false;
  protected readonly options: LegacyAdapterOptions = { streamingMode: "incremental" };
  public readonly baseUrl: string;

  constructor(
    public readonly id: GatewayProviderId,
    baseUrl: string,
    private readonly apiKey?: string,
    public readonly name = "OpenAI-compatible endpoint"
  ) {
    super();
    this.baseUrl = baseUrl;
  }

  public override configurationIssue(): string | null {
    if (!this.baseUrl) return "No OpenAI-compatible base URL is configured.";
    const validation = validateProviderUrl(this.baseUrl, {
      label: "OpenAI-compatible base URL",
    });
    return validation.ok ? null : (validation.reason ?? "The base URL is not usable.");
  }

  protected createAdapter(): ModelProvider {
    return new OpenAICompatibleProvider(this.baseUrl, this.apiKey);
  }
}
