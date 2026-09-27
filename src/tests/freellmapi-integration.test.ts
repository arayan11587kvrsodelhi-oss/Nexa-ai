/**
 * FreeLLMAPI integration tests: provider registration, router selection, and
 * the demo-fallback safety rule.
 *
 * The database module is replaced with a scripted chain so no PostgreSQL is
 * required; every network call is served by a stubbed `fetch`, so no live
 * FreeLLMAPI instance is required either. Where a prerequisite cannot be
 * verified here it is stated in the test name rather than assumed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DEFAULT_MODELS, DiscoveredModel, ModelRegistry, ProviderRegistry } from "@/lib/ai/registry";
import { ModelRouter } from "@/lib/ai/router";
import { InferenceService } from "@/lib/ai/inference";
import { ProviderError } from "@/lib/ai/provider-errors";
import { DemoSandboxProvider } from "@/lib/ai/providers/demo";
import { FreeLLMAPIProvider } from "@/lib/ai/providers/freellmapi";
import { OllamaProvider } from "@/lib/ai/providers/ollama";

const BASE = "http://127.0.0.1:8099";

const mockState = vi.hoisted(() => ({ configRows: [] as Array<Record<string, unknown>> }));

interface StubChain {
  from: () => StubChain;
  where: () => StubChain;
  limit: () => Promise<Array<Record<string, unknown>>>;
}

vi.mock("@/db", () => {
  const chain: StubChain = {
    from: () => chain,
    where: () => chain,
    limit: async () => mockState.configRows,
  };
  return {
    db: { select: () => chain },
    checkDatabase: async () => ({ configured: true, reachable: true, message: "scripted" }),
  };
});

const ENV_KEYS = [
  "DEFAULT_PROVIDER",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "FREELLMAPI_BASE_URL",
  "FREELLMAPI_API_KEY",
  "FREELLMAPI_MODEL",
  "ALLOW_DEMO_FALLBACK",
] as const;

let savedEnv: Record<string, string | undefined> = {};

function modelConfigRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cfg_1",
    userId: "usr_1",
    provider: "freellmapi",
    baseUrl: "",
    modelName: "",
    apiKey: null,
    temperature: 0.4,
    topP: 0.9,
    maxTokens: 512,
    contextWindow: 8192,
    systemPrompt: null,
    isDefault: true,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function discoveredModel(id: string, overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id,
    provider: "freellmapi",
    name: id,
    contextWindow: null,
    supportsStreaming: null,
    supportsTools: null,
    supportsVision: null,
    discoveredAt: new Date().toISOString(),
    ...overrides,
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function catalogResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function doneStream(): Response {
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  mockState.configRows = [];
  ProviderRegistry.clearDiscoveredModels();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  ProviderRegistry.clearDiscoveredModels();
});

describe("provider registry", () => {
  it("registers FreeLLMAPI as a first-class provider without claiming capabilities", () => {
    const entry = ProviderRegistry.get("freellmapi");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      id: "freellmapi",
      name: "FreeLLMAPI",
      protocol: "openai-compatible",
      enabled: false,
      baseUrl: null,
    });
    // Streaming and real inference are true by construction of the adapter;
    // tools and vision are unknown, so they are null rather than a claim.
    expect(entry?.capabilities).toEqual({
      streaming: true,
      realInference: true,
      tools: null,
      vision: null,
    });
    expect(entry?.note).toContain("FREELLMAPI_BASE_URL");
  });

  it("enables FreeLLMAPI only when FREELLMAPI_BASE_URL is configured, and never exposes the key", () => {
    process.env.FREELLMAPI_BASE_URL = `${BASE}/v1`;
    process.env.FREELLMAPI_API_KEY = "sk-must-not-be-exposed";

    const entry = ProviderRegistry.get("freellmapi");
    expect(entry?.enabled).toBe(true);
    expect(entry?.baseUrl).toBe(`${BASE}/v1`);
    expect(JSON.stringify(ProviderRegistry.getAll())).not.toContain("sk-must-not-be-exposed");
  });

  it("keeps discovered models out of the curated catalogue", () => {
    ProviderRegistry.setDiscoveredModels("freellmapi", [discoveredModel("vendor/model-a")]);

    expect(DEFAULT_MODELS.some((m) => m.provider === "freellmapi")).toBe(false);
    expect(ModelRegistry.getAll().some((m) => m.provider === "freellmapi")).toBe(false);
    expect(ProviderRegistry.getDiscoveredModel("freellmapi", "vendor/model-a")?.provider).toBe(
      "freellmapi"
    );
  });
});

describe("model router", () => {
  it("keeps its previous behaviour when no active provider is supplied", () => {
    const decision = ModelRouter.route("Tell me about the history of tea drinking in Asia.");
    expect(decision.modelId).not.toBe("");
    expect(ModelRegistry.getById(decision.modelId)?.provider).toBe("ollama");
  });

  it("routes to a discovered FreeLLMAPI model when FreeLLMAPI is active", () => {
    ProviderRegistry.setDiscoveredModels("freellmapi", [
      discoveredModel("vendor/model-a", { contextWindow: 8192 }),
    ]);

    const decision = ModelRouter.route(
      "Tell me about the history of tea drinking in Asia.",
      undefined,
      undefined,
      [],
      "freellmapi"
    );

    expect(decision.modelId).toBe("vendor/model-a");
    expect(decision.capabilities.supportsTools).toBe(false);
    expect(decision.capabilities.supportsVision).toBe(false);
    expect(decision.capabilities.contextWindow).toBe(8192);
    expect(decision.reason).toContain("FreeLLMAPI");
  });

  it("does not invent a model when FreeLLMAPI has not reported any yet", () => {
    const decision = ModelRouter.route("Hello there, tell me something.", undefined, undefined, [], "freellmapi");
    expect(decision.modelId).toBe("");
    expect(decision.capabilities).toEqual({
      supportsTools: false,
      supportsVision: false,
      contextWindow: 0,
    });
    expect(decision.reason).toContain("has not reported any models");
  });

  it("never forwards an Ollama model id to FreeLLMAPI", () => {
    ProviderRegistry.setDiscoveredModels("freellmapi", [discoveredModel("vendor/model-a")]);

    const decision = ModelRouter.route("hello", undefined, "llama3.2:3b", [], "freellmapi");
    expect(decision.modelId).toBe("vendor/model-a");
    expect(decision.modelId).not.toBe("llama3.2:3b");
  });

  it("honours an explicitly requested model that FreeLLMAPI reported", () => {
    ProviderRegistry.setDiscoveredModels("freellmapi", [
      discoveredModel("vendor/model-a"),
      discoveredModel("vendor/model-b"),
    ]);

    const decision = ModelRouter.route("hello", undefined, "vendor/model-b", [], "freellmapi");
    expect(decision.modelId).toBe("vendor/model-b");
    expect(decision.isAutomatic).toBe(false);
  });

  it("selects a provider explicitly and never falls back to the demo sandbox", () => {
    const explicit = ModelRouter.selectProvider("freellmapi");
    expect(explicit.provider).toBeInstanceOf(FreeLLMAPIProvider);
    expect(explicit.providerId).toBe("freellmapi");
    expect(explicit.explicit).toBe(true);

    const byDefault = ModelRouter.selectProvider();
    expect(byDefault.provider).toBeInstanceOf(OllamaProvider);
    expect(byDefault.providerId).toBe("ollama");
    expect(byDefault.explicit).toBe(false);
    expect(byDefault.provider).not.toBeInstanceOf(DemoSandboxProvider);

    process.env.DEFAULT_PROVIDER = "freellmapi";
    expect(ModelRouter.selectProvider().provider).toBeInstanceOf(FreeLLMAPIProvider);

    const demo = ModelRouter.selectProvider("demo");
    expect(demo.provider).toBeInstanceOf(DemoSandboxProvider);
    expect(demo.explicit).toBe(true);
  });
});


describe("inference service — FreeLLMAPI selection", () => {
  it("resolves the active provider type without any network call", async () => {
    mockState.configRows = [modelConfigRow({ provider: "freellmapi" })];
    const fetchMock = stubFetch(async () => catalogResponse(["vendor/model-a"]));

    expect(await InferenceService.resolveActiveProviderType("usr_1")).toBe("freellmapi");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a misconfigured provider when FREELLMAPI_BASE_URL is missing (no request made)", async () => {
    mockState.configRows = [modelConfigRow({ provider: "freellmapi" })];
    const fetchMock = stubFetch(async () => catalogResponse(["vendor/model-a"]));

    const failure = await InferenceService.getActiveProvider("usr_1").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).code).toBe("misconfigured");
    expect((failure as ProviderError).providerId).toBe("freellmapi");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a stored endpoint/key for FreeLLMAPI and uses the server environment", async () => {
    process.env.FREELLMAPI_BASE_URL = BASE;
    process.env.FREELLMAPI_API_KEY = "sk-from-environment";
    process.env.FREELLMAPI_MODEL = "vendor/model-env";
    mockState.configRows = [
      modelConfigRow({
        provider: "freellmapi",
        baseUrl: "http://attacker.invalid:1234",
        apiKey: "sk-stored-in-database",
        modelName: "",
      }),
    ];

    const resolved = await InferenceService.resolveConfig("usr_1");
    expect(resolved.baseUrl).toBe(BASE);
    expect(resolved.apiKey).toBe("sk-from-environment");
    expect(resolved.modelName).toBe("vendor/model-env");
  });

  it("keeps the previous resolution rules for Ollama", async () => {
    mockState.configRows = [
      modelConfigRow({ provider: "ollama", baseUrl: "http://localhost:11434", modelName: "mistral:7b" }),
    ];
    const resolved = await InferenceService.resolveConfig("usr_1");
    expect(resolved.provider).toBe("ollama");
    expect(resolved.baseUrl).toBe("http://localhost:11434");
    expect(resolved.modelName).toBe("mistral:7b");
  });

  it("returns the FreeLLMAPI adapter and records discovered models when it is reachable", async () => {
    process.env.FREELLMAPI_BASE_URL = BASE;
    mockState.configRows = [modelConfigRow({ provider: "freellmapi", modelName: "" })];
    stubFetch(async () => catalogResponse(["vendor/model-a", "vendor/model-b"]));

    const active = await InferenceService.getActiveProvider("usr_1");
    expect(active.provider).toBeInstanceOf(FreeLLMAPIProvider);
    expect(active.isDemo).toBe(false);
    // No configured model → the first model the provider reported is used.
    expect(active.config.modelName).toBe("vendor/model-a");
    expect(ProviderRegistry.getDiscoveredModels("freellmapi").map((m) => m.id)).toEqual([
      "vendor/model-a",
      "vendor/model-b",
    ]);
  });

  it("prefers the configured model over the discovered order", async () => {
    process.env.FREELLMAPI_BASE_URL = BASE;
    mockState.configRows = [modelConfigRow({ provider: "freellmapi", modelName: "vendor/model-b" })];
    stubFetch(async () => catalogResponse(["vendor/model-a", "vendor/model-b"]));

    const active = await InferenceService.getActiveProvider("usr_1");
    expect(active.config.modelName).toBe("vendor/model-b");
  });
});


describe("inference service — streaming", () => {
  it("sends the FreeLLMAPI model, not the routed Ollama model id", async () => {
    process.env.FREELLMAPI_BASE_URL = BASE;
    mockState.configRows = [modelConfigRow({ provider: "freellmapi", modelName: "" })];

    const chatPayloads: Array<Record<string, unknown>> = [];
    stubFetch(async (url, init) => {
      if (url.endsWith("/v1/models")) return catalogResponse(["vendor/model-a"]);
      chatPayloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return doneStream();
    });

    const result = await InferenceService.streamChat(
      "usr_1",
      { model: "llama3.2:3b", messages: [{ role: "user", content: "hi" }] },
      () => undefined
    );

    expect(chatPayloads).toHaveLength(1);
    expect(chatPayloads[0].model).toBe("vendor/model-a");
    expect(result.modelUsed).toBe("vendor/model-a");
    expect(result.providerId).toBe("freellmapi");
    expect(result.isDemo).toBe(false);
  });
});

describe("demo fallback safety", () => {
  it("never substitutes the demo sandbox when FreeLLMAPI fails, even with ALLOW_DEMO_FALLBACK=true", async () => {
    process.env.FREELLMAPI_BASE_URL = BASE;
    process.env.ALLOW_DEMO_FALLBACK = "true";
    mockState.configRows = [modelConfigRow({ provider: "freellmapi" })];
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const failure = await InferenceService.getActiveProvider("usr_1").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).not.toBeInstanceOf(DemoSandboxProvider);
    expect((failure as ProviderError).providerId).toBe("freellmapi");
    expect((failure as ProviderError).healthStatus).toBe("unavailable");
  });

  it("still honours the explicit opt-in for Ollama, unchanged", async () => {
    process.env.ALLOW_DEMO_FALLBACK = "true";
    mockState.configRows = [modelConfigRow({ provider: "ollama", baseUrl: "http://127.0.0.1:9" })];
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const active = await InferenceService.getActiveProvider("usr_1");
    expect(active.isDemo).toBe(true);
    expect(active.provider).toBeInstanceOf(DemoSandboxProvider);
  });

  it("fails transparently for Ollama when the opt-in is absent", async () => {
    mockState.configRows = [modelConfigRow({ provider: "ollama", baseUrl: "http://127.0.0.1:9" })];
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const failure = await InferenceService.getActiveProvider("usr_1").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).message).toContain("Local AI engine unavailable");
  });
});

