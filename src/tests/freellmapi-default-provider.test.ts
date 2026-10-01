/**
 * NEXA runs on FreeLLMAPI.
 *
 * These tests pin the property that prompted the change: Ollama used to be the
 * hard-coded default everywhere a provider was not explicitly named, so a
 * deployment with a perfectly good FreeLLMAPI installation still reported
 * "Ollama is unavailable" whenever `DEFAULT_PROVIDER` was absent or malformed.
 *
 * The provider abstraction is deliberately NOT removed — Ollama remains a
 * selectable, explicitly-addressable provider. What changed is only the
 * *default* and the *status* reporting.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { DEFAULT_PROVIDER_TYPE, resolveProviderType } from "@/lib/ai/providers/factory";
import { ModelRouter } from "@/lib/ai/router";
import { ProviderRegistry, type DiscoveredModel } from "@/lib/ai/registry";
import { loadGatewayConfig } from "@/lib/gateway/config";
import { FreeLLMAPIProvider } from "@/lib/ai/providers/freellmapi";
import { OllamaProvider } from "@/lib/ai/providers/ollama";

const ENV_KEYS = [
  "DEFAULT_PROVIDER",
  "FREELLMAPI_BASE_URL",
  "FREELLMAPI_API_KEY",
  "FREELLMAPI_MODEL",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "NEXA_PROVIDER_ORDER",
  "NEXA_ALLOW_PRIVATE_PROVIDER_HOSTS",
] as const;

const saved = new Map<string, string | undefined>();
for (const key of ENV_KEYS) saved.set(key, process.env[key]);

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

beforeEach(() => {
  clearEnv();
  ProviderRegistry.clearDiscoveredModels();
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  ProviderRegistry.clearDiscoveredModels();
  vi.unstubAllEnvs();
});

const BASE = "http://127.0.0.1:31415/v1";

function discovered(id: string): DiscoveredModel {
  return {
    id,
    name: id,
    provider: "freellmapi",
    supportsStreaming: true,
    contextWindow: null,
    supportsTools: null,
    supportsVision: null,
    discoveredAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("FreeLLMAPI is the default provider", () => {
  it("names FreeLLMAPI as the single default", () => {
    expect(DEFAULT_PROVIDER_TYPE).toBe("freellmapi");
  });

  it("resolves an absent provider to FreeLLMAPI, never to Ollama", () => {
    expect(resolveProviderType(undefined)).toBe("freellmapi");
    expect(resolveProviderType("")).toBe("freellmapi");
    expect(resolveProviderType(null)).toBe("freellmapi");
  });

  it("resolves a malformed provider to FreeLLMAPI, never to Ollama", () => {
    for (const bad of ["not-a-provider", "freellmapii", "0", "null"]) {
      expect(resolveProviderType(bad), bad).toBe("freellmapi");
    }
  });

  it("still honours an explicitly requested provider", () => {
    // The abstraction is intact: Ollama is addressable, just never default.
    expect(resolveProviderType("ollama")).toBe("ollama");
    expect(resolveProviderType("openai_compatible")).toBe("openai_compatible");
    expect(resolveProviderType("demo")).toBe("demo");
  });

  it("builds a FreeLLMAPI adapter when nothing is requested", () => {
    const chosen = ModelRouter.selectProvider();
    expect(chosen.provider).toBeInstanceOf(FreeLLMAPIProvider);
    expect(chosen.provider).not.toBeInstanceOf(OllamaProvider);
    expect(chosen.providerId).toBe("freellmapi");
  });

  it("does not fall back to Ollama when DEFAULT_PROVIDER is malformed", () => {
    process.env.DEFAULT_PROVIDER = "totally-bogus";
    expect(ModelRouter.selectProvider().providerId).toBe("freellmapi");
  });
});

describe("status and health report FreeLLMAPI, not Ollama", () => {
  it("never marks Ollama as an enabled/selectable provider", () => {
    const ollama = ProviderRegistry.get("ollama");
    expect(ollama?.enabled).toBe(false);
    expect(ollama?.note).toMatch(/not the active engine/i);
  });

  it("reports FreeLLMAPI as the engine once its base URL is configured", () => {
    process.env.FREELLMAPI_BASE_URL = BASE;
    const free = ProviderRegistry.get("freellmapi");
    expect(free?.enabled).toBe(true);
    expect(free?.note).toMatch(/active engine/i);
  });

  it("disables the Ollama gateway entry so it is never routed to", () => {
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";
    const ollama = loadGatewayConfig().find((c) => c.id === "ollama");
    expect(ollama?.enabled).toBe(false);
    expect(ollama?.note).toMatch(/Disabled/);
  });

  it("keeps FreeLLMAPI as the first routable provider", () => {
    process.env.FREELLMAPI_BASE_URL = BASE;
    const configs = loadGatewayConfig();
    expect(configs.find((c) => c.enabled)?.id).toBe("freellmapi");
  });

  it("never leaks a credential through the provider registry", () => {
    process.env.FREELLMAPI_BASE_URL = BASE;
    process.env.FREELLMAPI_API_KEY = "sk-must-not-be-exposed";
    expect(JSON.stringify(ProviderRegistry.getAll())).not.toContain("sk-must-not-be-exposed");
  });
});

describe("the configured model comes from FREELLMAPI_MODEL", () => {
  it("routes to the configured model when the provider reported it", () => {
    process.env.FREELLMAPI_BASE_URL = BASE;
    process.env.FREELLMAPI_MODEL = "gemini-3.6-flash";
    ProviderRegistry.setDiscoveredModels("freellmapi", [
      discovered("gemini-3.6-flash"),
      discovered("auto"),
    ]);

    const decision = ModelRouter.route("hello there", undefined, undefined, [], "freellmapi");
    expect(decision.modelId).toBe("gemini-3.6-flash");
    expect(decision.modelId).not.toBe("llama3.2:3b");
    expect(decision.isAutomatic).toBe(false);
    expect(decision.reason).toContain("FREELLMAPI_MODEL");
  });

  it("never falls back to an Ollama model id for a FreeLLMAPI request", () => {
    process.env.FREELLMAPI_BASE_URL = BASE;
    // No FREELLMAPI_MODEL set at all, while OLLAMA_MODEL names a local model.
    process.env.OLLAMA_MODEL = "llama3.2:3b";
    ProviderRegistry.setDiscoveredModels("freellmapi", [discovered("gemini-3.6-flash")]);

    const decision = ModelRouter.route("hello", undefined, undefined, [], "freellmapi");
    expect(decision.modelId).toBe("gemini-3.6-flash");
    expect(decision.modelId).not.toContain("llama");
  });

  it("still refuses to forward an Ollama model id to FreeLLMAPI", () => {
    process.env.FREELLMAPI_BASE_URL = BASE;
    ProviderRegistry.setDiscoveredModels("freellmapi", [discovered("gemini-3.6-flash")]);

    const decision = ModelRouter.route("hi", undefined, "llama3.2:3b", [], "freellmapi");
    expect(decision.modelId).toBe("gemini-3.6-flash");
  });
});
