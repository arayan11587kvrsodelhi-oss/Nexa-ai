import { ProviderType } from "@/types";
import { ModelProvider } from "../types";
import { DemoSandboxProvider } from "./demo";
import { FreeLLMAPIProvider } from "./freellmapi";
import { OllamaProvider } from "./ollama";
import { OpenAICompatibleProvider } from "./openai-compatible";

/**
 * The single place provider adapters are constructed.
 *
 * Routing/selection lives in `src/lib/ai/router.ts` and `inference.ts`; this
 * module only maps a provider identity onto its adapter so the switch is not
 * duplicated in every route.
 *
 * It deliberately implements **no fallback**: a failure in one provider never
 * causes a different provider (and never the simulated demo sandbox) to be
 * returned. If a caller asks for FreeLLMAPI, it gets FreeLLMAPI.
 */

export const PROVIDER_TYPES: readonly ProviderType[] = [
  "ollama",
  "openai_compatible",
  "vllm",
  "freellmapi",
  "custom",
  "demo",
];

/**
 * The provider NEXA uses when nothing else selects one.
 *
 * FreeLLMAPI is the sole default. It is the only provider whose endpoint and
 * credential are configured on the server, and it is never reached by an
 * implicit fallback: a FreeLLMAPI failure surfaces as a provider error rather
 * than silently serving another engine's output.
 *
 * This constant is the single place that default is defined. Every
 * "no provider was specified" path resolves through
 * `resolveProviderType()`, so changing it here changes the application's
 * default in one edit instead of leaving `"ollama"` literals scattered across
 * the routes, the inference service and the router.
 */
export const DEFAULT_PROVIDER_TYPE: ProviderType = "freellmapi";

export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === "string" && (PROVIDER_TYPES as readonly string[]).includes(value);
}

/**
 * Coerce an untrusted provider string (env var or database column) into a known
 * provider.
 *
 * An unrecognised value resolves to `fallback`, which defaults to
 * `DEFAULT_PROVIDER_TYPE`. Ollama remains a *selectable* provider — the
 * abstraction is unchanged and an operator can still address it explicitly —
 * but it is never the value a missing or malformed setting resolves to.
 */
export function resolveProviderType(
  value: unknown,
  fallback: ProviderType = DEFAULT_PROVIDER_TYPE
): ProviderType {
  return isProviderType(value) ? value : fallback;
}

export interface ProviderOverrides {
  /** Only ever passed by server-side callers. Never from a request body. */
  baseUrl?: string;
  /** Only ever passed by server-side callers. Never from a request body. */
  apiKey?: string;
}

export function createProvider(
  provider: ProviderType,
  overrides: ProviderOverrides = {}
): ModelProvider {
  switch (provider) {
    case "demo":
      return new DemoSandboxProvider();
    case "freellmapi":
      // Endpoint and credential resolution live in the adapter (environment-first).
      return new FreeLLMAPIProvider(overrides.baseUrl, overrides.apiKey);
    case "openai_compatible":
    case "vllm":
      return new OpenAICompatibleProvider(overrides.baseUrl, overrides.apiKey);
    case "ollama":
    case "custom":
    default:
      // `custom` has no dedicated adapter; the Ollama-shaped adapter is the
      // historical behaviour for both `custom` and unknown values.
      return new OllamaProvider(overrides.baseUrl);
  }
}

/** Display name for a provider identity. Never invents a capability claim. */
export function providerDisplayName(provider: ProviderType): string {
  switch (provider) {
    case "ollama":
      return "Ollama";
    case "openai_compatible":
      return "OpenAI-compatible endpoint";
    case "vllm":
      return "vLLM";
    case "freellmapi":
      return "FreeLLMAPI";
    case "demo":
      return "NEXA demo sandbox";
    case "custom":
    default:
      return "custom provider";
  }
}

/** Short, honest description of where a response will come from. */
export function describeProvider(provider: ProviderType): string {
  switch (provider) {
    case "ollama":
      return "local AI engine";
    case "openai_compatible":
    case "vllm":
      return "configured OpenAI-compatible endpoint";
    case "freellmapi":
      return "FreeLLMAPI (external provider)";
    case "demo":
      return "NEXA demo sandbox (simulated, not a real model)";
    case "custom":
    default:
      return "configured provider";
  }
}
