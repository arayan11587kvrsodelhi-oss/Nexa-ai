/**
 * NEXA AI Gateway — provider factory.
 *
 * The single place a provider adapter is constructed. Adding a provider means
 * adding one branch here (and one adapter file); nothing in the router, the
 * gateway, or the API routes changes.
 */
import {
  AI_HORDE_ANONYMOUS_KEY,
  envInt,
  loadGatewayConfig,
  type GatewayProviderConfig,
} from "../config";
import type { AIProvider, GatewayProviderId } from "../types";
import { AIHordeProvider } from "./ai-horde";
import { ExternalFreeLLMAPIProvider } from "./external-freellmapi";
import { OllamaGatewayProvider } from "./ollama";
import { OpenAICompatibleGatewayProvider } from "./openai-compatible";

/** Generous bound: AI Horde queues generations. */
export const AI_HORDE_TIMEOUT_MS = envInt("AI_HORDE_TIMEOUT_MS", 120_000, 5_000, 600_000);

export type ProviderOverrides = Partial<
  Record<GatewayProviderId, { baseUrl?: string; apiKey?: string }>
>;

export function createGatewayProvider(config: GatewayProviderConfig): AIProvider {
  switch (config.id) {
    case "aihorde":
      return new AIHordeProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey ?? AI_HORDE_ANONYMOUS_KEY,
        timeoutMs: AI_HORDE_TIMEOUT_MS,
        anonymousKey: AI_HORDE_ANONYMOUS_KEY,
        ...(config.preferredModel ? { preferredModel: config.preferredModel } : {}),
      });
    case "ollama":
      return new OllamaGatewayProvider(config.baseUrl);
    case "openai_compatible":
      return new OpenAICompatibleGatewayProvider(
        "openai_compatible",
        config.baseUrl,
        config.apiKey,
        config.name
      );
    case "vllm":
      return new OpenAICompatibleGatewayProvider("vllm", config.baseUrl, config.apiKey, "vLLM");
    case "freellmapi":
      return new ExternalFreeLLMAPIProvider(config.baseUrl, config.apiKey);
    default: {
      const exhaustive: never = config.id;
      throw new Error(`No gateway adapter is registered for provider '${String(exhaustive)}'.`);
    }
  }
}

/**
 * Every *configured* provider, in deterministic priority order.
 *
 * A provider whose configuration is unusable is constructed too, so the
 * diagnostics endpoint can explain why it is disabled — but it is never routed
 * to, and `enabled` is reported honestly.
 */
export function createConfiguredProviders(overrides: ProviderOverrides = {}): {
  providers: AIProvider[];
  configs: GatewayProviderConfig[];
} {
  const configs = loadGatewayConfig(overrides);
  return {
    configs,
    providers: configs.filter((config) => config.enabled).map(createGatewayProvider),
  };
}

/** All known provider configs, including the disabled ones. */
export function allProviderConfigs(overrides: ProviderOverrides = {}): GatewayProviderConfig[] {
  return loadGatewayConfig(overrides);
}
