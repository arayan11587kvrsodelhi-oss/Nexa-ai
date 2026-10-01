/**
 * FreeLLMAPI routing must honour the operator-configured `FREELLMAPI_MODEL`.
 *
 * ## The defect this locks down
 *
 * `src/lib/gateway/config.ts` already loads `FREELLMAPI_MODEL` as the FreeLLMAPI
 * entry's `preferredModel`, but `ModelRouter.routeWithinFreellmapi` ignored it:
 *
 *     const chosen = explicitModel ? catalog.find(...) : catalog[0];
 *
 * So with no explicit model, NEXA always took `catalog[0]` — the first model
 * FreeLLMAPI happened to report, which is `auto`. `auto` made FreeLLMAPI route
 * the request to whichever upstream it picked, and a configured
 * `llama-3.2-3b` was ignored entirely.
 *
 * ## Required order
 *
 *   1. explicit request, if that id is in the discovered catalog
 *   2. configured FREELLMAPI_MODEL, if that id is in the discovered catalog
 *   3. first discovered model, only if neither applies
 *
 * An id absent from the catalog is never treated as available, and FreeLLMAPI
 * routing never falls back to another provider.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { ModelRouter } from "@/lib/ai/router";
import { ProviderRegistry, DiscoveredModel } from "@/lib/ai/registry";

/**
 * The env vars the gateway loader reads. The base URL must be a private loopback
 * address, which the loader permits; without it the FreeLLMAPI entry is disabled
 * and carries no `preferredModel`.
 */
const ENV_KEYS = ["FREELLMAPI_MODEL", "FREELLMAPI_BASE_URL", "NEXA_PROVIDER_ORDER"];
const saved = new Map<string, string | undefined>();

/** `auto` is deliberately first in discovery order: it is what broke routing. */
const CATALOG: DiscoveredModel[] = [
  {
    id: "auto",
    provider: "freellmapi",
    name: "auto",
    contextWindow: 131072,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    discoveredAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "llama-3.2-3b",
    provider: "freellmapi",
    name: "Llama 3.2 3B",
    contextWindow: 131072,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    discoveredAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "qwen3.5-0.8b",
    provider: "freellmapi",
    name: "Qwen 3.5 0.8B",
    // Distinct capability values, so a wrong pick is detectable.
    contextWindow: 32768,
    supportsStreaming: false,
    supportsTools: false,
    supportsVision: true,
    discoveredAt: "2026-01-01T00:00:00.000Z",
  },
];

beforeEach(() => {
  for (const key of ENV_KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    delete process.env[key];
  }
  // Enable the FreeLLMAPI gateway entry so it carries a preferredModel.
  process.env.FREELLMAPI_BASE_URL = "http://127.0.0.1:31415/v1";
  ProviderRegistry.setDiscoveredModels("freellmapi", CATALOG);
});

afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("ModelRouter — FreeLLMAPI preferred model", () => {
  it("selects the configured FREELLMAPI_MODEL instead of catalog[0] ('auto')", () => {
    process.env.FREELLMAPI_MODEL = "llama-3.2-3b";
    const decision = ModelRouter.route("hello", undefined, undefined, [], "freellmapi");

    expect(decision.modelId).toBe("llama-3.2-3b");
    expect(decision.modelId).not.toBe("auto");
    expect(decision.reason).toContain("configured preferred model");
  });

  it("lets an explicit valid model beat the configured preferred model", () => {
    process.env.FREELLMAPI_MODEL = "llama-3.2-3b";
    const decision = ModelRouter.route(
      "hello",
      undefined,
      "qwen3.5-0.8b",
      [],
      "freellmapi"
    );

    expect(decision.modelId).toBe("qwen3.5-0.8b");
    expect(decision.reason).toContain("explicitly requested");
  });

  it("does not select a configured model that is absent from the catalog", () => {
    process.env.FREELLMAPI_MODEL = "not-a-real-model";
    const decision = ModelRouter.route("hello", undefined, undefined, [], "freellmapi");

    // Must not be treated as available; falls through to discovered behaviour.
    expect(decision.modelId).toBe("auto");
    expect(decision.reason).toContain("not in the discovered model catalog");
    expect(decision.reason).toContain("not-a-real-model");
  });

  it("preserves first-discovered-model behaviour when nothing is configured", () => {
    const decision = ModelRouter.route("hello", undefined, undefined, [], "freellmapi");

    expect(decision.modelId).toBe("auto");
    expect(decision.reason).toContain("first model it reported");
    expect(decision.isAutomatic).toBe(true);
  });

  it("reports capabilities from the selected discovered model", () => {
    process.env.FREELLMAPI_MODEL = "qwen3.5-0.8b";
    const decision = ModelRouter.route("hello", undefined, undefined, [], "freellmapi");

    expect(decision.modelId).toBe("qwen3.5-0.8b");
    expect(decision.capabilities.contextWindow).toBe(32768);
    expect(decision.capabilities.supportsVision).toBe(true);
    // `null` must surface as false, never as an optimistic default.
    expect(decision.capabilities.supportsTools).toBe(false);
  });

  it("keeps isAutomatic semantics: explicit false, configured false, discovered true", () => {
    process.env.FREELLMAPI_MODEL = "llama-3.2-3b";

    const configured = ModelRouter.route("hi", undefined, undefined, [], "freellmapi");
    expect(configured.isAutomatic).toBe(false);

    const explicit = ModelRouter.route(
      "hi",
      undefined,
      "qwen3.5-0.8b",
      [],
      "freellmapi"
    );
    expect(explicit.isAutomatic).toBe(false);

    delete process.env.FREELLMAPI_MODEL;
    const automatic = ModelRouter.route("hi", undefined, undefined, [], "freellmapi");
    expect(automatic.isAutomatic).toBe(true);
  });

  it("never falls back to another provider", () => {
    process.env.FREELLMAPI_MODEL = "llama-3.2-3b";
    const decision = ModelRouter.route("hello", undefined, undefined, [], "freellmapi");

    // Every path must stay on FreeLLMAPI; no Ollama/demo/AI Horde model id.
    expect(CATALOG.some((m) => m.id === decision.modelId)).toBe(true);
    expect(decision.modelId).not.toBe("llama3.2:3b");
  });

  it("still honours the profile heuristic for the profile label", () => {
    process.env.FREELLMAPI_MODEL = "llama-3.2-3b";
    const decision = ModelRouter.route(
      "fix this function and debug the bug",
      undefined,
      undefined,
      [],
      "freellmapi"
    );

    expect(decision.profile).toBe("CODING");
    expect(decision.modelId).toBe("llama-3.2-3b");
  });

  it("keeps the empty-catalog behaviour unchanged", () => {
    process.env.FREELLMAPI_MODEL = "llama-3.2-3b";
    ProviderRegistry.clearDiscoveredModels("freellmapi");

    const decision = ModelRouter.route("hello", undefined, undefined, [], "freellmapi");

    expect(decision.modelId).toBe("");
    expect(decision.capabilities.contextWindow).toBe(0);
    expect(decision.isAutomatic).toBe(true);
  });
});
