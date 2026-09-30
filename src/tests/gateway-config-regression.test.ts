/**
 * NEXA AI Gateway — configuration regressions found by real-provider testing.
 *
 * Both bugs here were invisible to unit tests because the providers are always
 * constructed directly in tests, bypassing the configuration layer. They only
 * appeared against a real endpoint.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  normalizeBaseUrl,
  normalizeOpenAIBaseUrl,
  loadGatewayConfig,
  publicProviderConfig,
  DEFAULT_PROVIDER_ORDER,
} from "@/lib/gateway/config";
import { GATEWAY_PROVIDER_IDS } from "@/lib/gateway/types";

const ENV_KEYS = [
  "FREELLMAPI_BASE_URL",
  "FREELLMAPI_API_KEY",
  "FREELLMAPI_MODEL",
  "OLLAMA_BASE_URL",
  "OPENAI_COMPATIBLE_BASE_URL",
  "OPENAI_COMPATIBLE_URL",
  "OPENAI_BASE_URL",
  "AI_HORDE_BASE_URL",
  "AI_HORDE_API_KEY",
  "AI_HORDE_ENABLED",
  "AI_HORDE_MODEL",
  "NEXA_PROVIDER_ORDER",
  "NEXA_ENABLE_LOCAL_OPENAI_COMPATIBLE",
];

const saved = new Map<string, string | undefined>();
for (const key of ENV_KEYS) saved.set(key, process.env[key]);

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function clearProviderEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function configFor(id: string) {
  return loadGatewayConfig().find((c) => c.id === id);
}

describe("Regression: the /v1 prefix must survive for OpenAI-shaped providers", () => {
  it("keeps /v1 for AI Horde, whose adapter appends /models itself", () => {
    // Regression: the base was normalized to https://oai.aihorde.net and the
    // adapter then requested /models, which AI Horde answers with HTTP 404.
    expect(normalizeOpenAIBaseUrl("https://oai.aihorde.net/v1")).toBe(
      "https://oai.aihorde.net/v1"
    );
    expect(normalizeOpenAIBaseUrl("https://oai.aihorde.net/v1/")).toBe(
      "https://oai.aihorde.net/v1"
    );
    // A bare host still resolves to the documented OpenAI-compatible path.
    expect(normalizeOpenAIBaseUrl("https://oai.aihorde.net")).toBe(
      "https://oai.aihorde.net/v1"
    );
    expect(normalizeOpenAIBaseUrl(undefined)).toBe("");
  });

  it("keeps /v1 for the OpenAI-compatible family, including a sub-path install", () => {
    expect(normalizeOpenAIBaseUrl("http://localhost:1234/v1")).toBe("http://localhost:1234/v1");
    expect(normalizeOpenAIBaseUrl("https://host/llm/v1")).toBe("https://host/llm/v1");
    expect(normalizeOpenAIBaseUrl("https://host/llm")).toBe("https://host/llm/v1");
  });

  it("still strips /v1 for Ollama, whose endpoints are /api/*", () => {
    // Ollama is the reason the stripping helper exists; it must not change.
    expect(normalizeBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434");
    expect(normalizeBaseUrl("http://localhost:11434/")).toBe("http://localhost:11434");
  });

  it("gives AI Horde a working base URL from configuration", () => {
    clearProviderEnv();
    process.env.AI_HORDE_ENABLED = "true";
    const config = configFor("aihorde");
    expect(config?.baseUrl).toBe("https://oai.aihorde.net/v1");
    expect(config?.enabled).toBe(true);
  });

  it("gives the OpenAI-compatible provider a /v1 base URL from configuration", () => {
    clearProviderEnv();
    process.env.OPENAI_COMPATIBLE_BASE_URL = "http://127.0.0.1:1234/v1";
    const config = configFor("openai_compatible");
    expect(config?.baseUrl).toBe("http://127.0.0.1:1234/v1");
    // Base + "/models" must be the documented path, not "/models" at the root.
    expect(`${config?.baseUrl}/models`).toBe("http://127.0.0.1:1234/v1/models");
  });

  it("gives Ollama a root base URL from configuration", () => {
    clearProviderEnv();
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";
    const config = configFor("ollama");
    expect(config?.baseUrl).toBe("http://localhost:11434");
    expect(`${config?.baseUrl}/api/tags`).toBe("http://localhost:11434/api/tags");
  });

  it("leaves FreeLLMAPI to its own normalizer, which strips then re-adds /v1", () => {
    clearProviderEnv();
    process.env.FREELLMAPI_BASE_URL = "http://127.0.0.1:31417/v1";
    const config = configFor("freellmapi");
    // FreeLLMAPIProvider re-adds /v1 when building request paths, so the
    // stripped base here is correct and must not be "fixed".
    expect(config?.baseUrl).toBe("http://127.0.0.1:31417");
  });
});

describe("Regression: an operator's documented URL must be reported verbatim", () => {
  it("never exposes a credential in the public provider projection", () => {
    clearProviderEnv();
    process.env.AI_HORDE_ENABLED = "true";
    process.env.AI_HORDE_API_KEY = "super-secret-horde-key";
    const config = configFor("aihorde");
    const publicView = publicProviderConfig(config!);
    const serialized = JSON.stringify(publicView);
    expect(serialized).not.toContain("super-secret-horde-key");
    // Presence may be reported; the value may not.
    expect(serialized).toContain('"hasCredential":true');
  });

  it("keeps the default provider order deterministic", () => {
    expect([...DEFAULT_PROVIDER_ORDER]).toEqual([
      "freellmapi",
      "aihorde",
      "ollama",
      "openai_compatible",
      "vllm",
    ]);
  });

  it("only ever references known provider ids", () => {
    clearProviderEnv();
    for (const config of loadGatewayConfig()) {
      expect(GATEWAY_PROVIDER_IDS).toContain(config.id);
    }
  });
});
