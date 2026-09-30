/**
 * NEXA AI Gateway — Ollama provider adapter.
 *
 * Wraps the existing, proven `OllamaProvider` (NDJSON streaming against
 * `POST /api/chat`, model listing via `GET /api/tags`). No wire code is
 * duplicated and no behaviour changes; the adapter only normalizes results into
 * the gateway contracts.
 */
import type { ModelProvider } from "@/lib/ai/types";
import { OllamaProvider } from "@/lib/ai/providers/ollama";
import { validateProviderUrl } from "../config";
import type { GatewayProviderId } from "../types";
import { LegacyBackedProvider, type LegacyAdapterOptions } from "./legacy-adapter";

export class OllamaGatewayProvider extends LegacyBackedProvider {
  public readonly id: GatewayProviderId = "ollama";
  public readonly name = "Ollama";
  public readonly requiresApiKey = false;
  protected readonly options: LegacyAdapterOptions = { streamingMode: "incremental" };

  public readonly baseUrl: string;

  constructor(baseUrl: string) {
    super();
    this.baseUrl = baseUrl;
  }

  public override configurationIssue(): string | null {
    if (!this.baseUrl) return "OLLAMA_BASE_URL is not set on the server.";
    const validation = validateProviderUrl(this.baseUrl, { label: "Ollama base URL" });
    return validation.ok ? null : (validation.reason ?? "The Ollama base URL is not usable.");
  }

  protected createAdapter(): ModelProvider {
    return new OllamaProvider(this.baseUrl);
  }
}
