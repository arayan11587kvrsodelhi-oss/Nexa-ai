/**
 * NEXA AI Gateway — pinning and model-reference parsing (Phase 6).
 *
 * A pinned `provider/model` must never drift to another provider: a user who
 * selected FreeLLMAPI must not silently get Ollama (or AI Horde), and vice
 * versa. That is how a request meant for a private local model ends up on a
 * public service.
 *
 * The historical AI Horde failure this also guards against —
 *   "AI Horde API error 406: Model None not known!"
 * — happens when an empty/absent model is forwarded upstream. It is a
 * reference-parsing problem, not a per-model problem, so it is fixed and
 * tested as one. No model name is special-cased anywhere.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { GatewayModelRegistry, normalizeModel } from "@/lib/gateway/registry";
import { GatewayRouter } from "@/lib/gateway/router";
import { GatewayHealthStore } from "@/lib/gateway/health";
import { GatewayError } from "@/lib/gateway/errors";
import { LegacyBackedProvider } from "@/lib/gateway/providers/legacy-adapter";
import { modelsFromIds } from "@/lib/gateway/providers/shared";
import { GATEWAY_PROVIDER_IDS, type AIProvider, type GatewayProviderId } from "@/lib/gateway/types";
import type { GatewayProviderConfig } from "@/lib/gateway/config";

const MODEL = "koboldcpp/Angelic_Eclipse-12B";

function fakeProvider(id: GatewayProviderId, requiresApiKey = false): AIProvider {
  return {
    id,
    name: id,
    requiresApiKey,
    baseUrl: `http://${id}.invalid`,
    configurationIssue: () => null,
    isConfigured: () => true,
    listModels: async () => [],
    health: async () => ({}) as never,
    chat: async () => ({}) as never,
    streamChat: async function* () {},
  };
}

function configFor(
  id: GatewayProviderId,
  priority: number,
  extra: Partial<GatewayProviderConfig> = {}
): GatewayProviderConfig {
  return {
    id,
    name: id,
    enabled: true,
    baseUrl: `http://${id}.invalid`,
    requiresApiKey: false,
    priority,
    note: "",
    ...extra,
  };
}

beforeEach(() => {
  GatewayHealthStore.reset();
  GatewayModelRegistry.reset();
});

describe("provider/model reference parsing", () => {
  it("splits a pinned reference into provider and model", () => {
    expect(
      GatewayModelRegistry.parseModelRef(`freellmapi/${MODEL}`, GATEWAY_PROVIDER_IDS)
    ).toEqual({ provider: "freellmapi", model: MODEL });
  });

  it("keeps a model id that itself contains slashes intact", () => {
    // `koboldcpp/Angelic_Eclipse-12B` is the *model*; only the first segment
    // that matches a known provider id is consumed.
    for (const provider of GATEWAY_PROVIDER_IDS) {
      expect(
        GatewayModelRegistry.parseModelRef(`${provider}/${MODEL}`, GATEWAY_PROVIDER_IDS)
      ).toEqual({ provider, model: MODEL });
    }
  });

  it("accepts the colon form as well as the slash form", () => {
    expect(GatewayModelRegistry.parseModelRef(`ollama:${MODEL}`, GATEWAY_PROVIDER_IDS)).toEqual({
      provider: "ollama",
      model: MODEL,
    });
  });

  it("leaves an unpinned model as a bare model id", () => {
    expect(GatewayModelRegistry.parseModelRef("llama3.2:3b", GATEWAY_PROVIDER_IDS)).toEqual({
      model: "llama3.2:3b",
    });
  });

  it("round-trips a pinned reference for every provider", () => {
    for (const provider of GATEWAY_PROVIDER_IDS) {
      const pinned = GatewayModelRegistry.modelRef(provider, MODEL);
      expect(GatewayModelRegistry.parseModelRef(pinned, GATEWAY_PROVIDER_IDS)).toEqual({
        provider,
        model: MODEL,
      });
    }
  });

  it("does not mistake a model whose name merely starts with a provider word", () => {
    expect(
      GatewayModelRegistry.parseModelRef("ollama-something/x", GATEWAY_PROVIDER_IDS).provider
    ).toBeUndefined();
  });
});

describe("a pinned model cannot drift to another provider", () => {
  const providers = [fakeProvider("ollama"), fakeProvider("freellmapi"), fakeProvider("aihorde")];

  beforeEach(() => {
    // Every provider advertises the *same* model id, the worst case for a
    // router that resolves by model name alone.
    for (const provider of providers) {
      GatewayModelRegistry.setModels(
        provider.id,
        modelsFromIds(provider.id, [MODEL], { requiresApiKey: false, supportsStreaming: true })
      );
    }
  });

  it("routes a freellmapi pin only to freellmapi", () => {
    const plan = GatewayRouter.plan({
      requestedModel: `freellmapi/${MODEL}`,
      stream: false,
      providers,
      configs: [configFor("ollama", 0), configFor("freellmapi", 1), configFor("aihorde", 2)],
    });
    expect(plan.strategy).toBe("explicit");
    expect(plan.candidates[0].provider).toBe("freellmapi");
    expect(plan.candidates.every((c) => c.provider === "freellmapi")).toBe(true);
  });

  it("routes an ollama pin only to ollama, even when freellmapi is preferred", () => {
    const plan = GatewayRouter.plan({
      requestedModel: `ollama/${MODEL}`,
      stream: false,
      providers,
      // freellmapi has the better (lower) priority on purpose.
      configs: [configFor("freellmapi", 0), configFor("ollama", 1), configFor("aihorde", 2)],
    });
    expect(plan.candidates[0].provider).toBe("ollama");
    expect(plan.candidates.every((c) => c.provider === "ollama")).toBe(true);
  });

  it("keeps a pinned aihorde model on aihorde", () => {
    const plan = GatewayRouter.plan({
      requestedModel: `aihorde/${MODEL}`,
      stream: true,
      providers,
      configs: [configFor("ollama", 0), configFor("freellmapi", 1), configFor("aihorde", 2)],
    });
    expect(plan.candidates[0].provider).toBe("aihorde");
    expect(plan.candidates.every((c) => c.provider === "aihorde")).toBe(true);
  });
});

describe("malformed and unresolvable references", () => {
  it("marks an explicitly requested unknown model as unverified rather than trusting it", () => {
    // Deliberate design: NEXA does not pretend it verified a model the provider
    // never listed, but it also does not refuse a user's explicit choice before
    // the provider has had a chance to answer. The plan is `explicit` and the
    // candidate is marked unverified; a provider 404 then normalizes to
    // ModelNotFound at request time.
    const providers = [fakeProvider("ollama")];
    GatewayModelRegistry.setModels(
      "ollama",
      modelsFromIds("ollama", ["llama3.2:3b"], { requiresApiKey: false, supportsStreaming: true })
    );
    const plan = GatewayRouter.plan({
      requestedModel: "notaprovider/whatever",
      stream: false,
      providers,
      configs: [configFor("ollama", 0)],
    });
    expect(plan.strategy).toBe("explicit");
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].reason).toMatch(/not present in the provider's discovered catalogue/);
  });

  it("throws a normalized error when no provider is configured at all", () => {
    expect(() =>
      GatewayRouter.plan({
        requestedModel: "auto",
        stream: false,
        providers: [],
        configs: [],
      })
    ).toThrow(/No provider\/model is currently eligible/);
  });

  it("refuses to build an upstream request for an empty model (the 406 guard)", async () => {
    // AI Horde answered "406 Model None not known!" when a request went out
    // without a model. The guard is in the adapter, before any fetch.
    class EmptyModelProvider extends LegacyBackedProvider {
      public readonly id = "aihorde" as const;
      public readonly name = "test";
      public readonly requiresApiKey = false;
      public readonly baseUrl = "http://x.invalid";
      protected readonly options = { streamingMode: "incremental" as const };
      public requested: string | null = null;
      protected createAdapter() {
        return {
          id: "test",
          name: "test",
          type: "custom" as const,
          baseUrl: "http://x.invalid",
          testConnection: async () => ({ ok: true, message: "" }),
          listModels: async () => [],
          generateStream: async (options: { model: string }) => {
            this.requested = options.model;
            return { fullText: "", latencyMs: 1 };
          },
        };
      }
    }

    for (const empty of ["", "   "]) {
      const provider = new EmptyModelProvider();
      const seen: Array<{ type: string; data?: unknown }> = [];
      for await (const chunk of provider.streamChat({
        model: empty,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      })) {
        seen.push(chunk as { type: string; data?: unknown });
      }
      // The upstream was never called, and the caller got a classified error.
      expect(provider.requested, `model=${JSON.stringify(empty)}`).toBeNull();
      expect(seen).toHaveLength(1);
      expect(seen[0].type).toBe("error");
      expect(seen[0].data).toBeInstanceOf(GatewayError);
    }
  });
});

describe("Phase 7 — auto routing is NEXA's decision", () => {
  it("is deterministic for the same input", () => {
    const providers = [fakeProvider("aihorde"), fakeProvider("ollama")];
    for (const id of ["aihorde", "ollama"] as const) {
      GatewayModelRegistry.setModels(
        id,
        modelsFromIds(id, ["model-a", "model-b"], {
          requiresApiKey: false,
          supportsStreaming: true,
        })
      );
    }
    const configs = [configFor("aihorde", 0), configFor("ollama", 1)];
    const first = GatewayRouter.plan({ requestedModel: "auto", stream: true, providers, configs });
    for (let i = 0; i < 5; i += 1) {
      expect(
        GatewayRouter.plan({ requestedModel: "auto", stream: true, providers, configs })
          .candidates
      ).toEqual(first.candidates);
    }
  });

  it("respects provider priority order", () => {
    const providers = [fakeProvider("ollama"), fakeProvider("aihorde")];
    for (const id of ["ollama", "aihorde"] as const) {
      GatewayModelRegistry.setModels(
        id,
        modelsFromIds(id, ["only"], { requiresApiKey: false, supportsStreaming: true })
      );
    }
    const plan = GatewayRouter.plan({
      requestedModel: "auto",
      stream: true,
      providers,
      configs: [configFor("aihorde", 0), configFor("ollama", 1)],
    });
    expect(plan.candidates[0].provider).toBe("aihorde");
  });

  it("excludes a provider that needs a credential it does not have", () => {
    const providers = [fakeProvider("openai_compatible", true), fakeProvider("aihorde")];
    GatewayModelRegistry.setModels(
      "openai_compatible",
      modelsFromIds("openai_compatible", ["secret-model"], {
        requiresApiKey: true,
        supportsStreaming: true,
      })
    );
    GatewayModelRegistry.setModels(
      "aihorde",
      modelsFromIds("aihorde", ["public-model"], {
        requiresApiKey: false,
        supportsStreaming: true,
      })
    );
    const plan = GatewayRouter.plan({
      requestedModel: "auto",
      stream: true,
      providers,
      configs: [
        configFor("openai_compatible", 0, { requiresApiKey: true, enabled: false }),
        configFor("aihorde", 1),
      ],
    });
    expect(plan.candidates.map((c) => c.provider)).not.toContain("openai_compatible");
    expect(plan.candidates[0].provider).toBe("aihorde");
  });

  it("excludes a model whose provider has a recorded recent failure", async () => {
    const providers = [fakeProvider("aihorde"), fakeProvider("ollama")];
    for (const id of ["aihorde", "ollama"] as const) {
      GatewayModelRegistry.setModels(
        id,
        modelsFromIds(id, ["m"], { requiresApiKey: false, supportsStreaming: true })
      );
    }
    await GatewayHealthStore.recordSuccess({ provider: "aihorde", latencyMs: 1 });
    // Two consecutive failures quarantine the provider.
    for (let i = 0; i < 2; i += 1) {
      await GatewayHealthStore.recordError({
        provider: "aihorde",
        error: new GatewayError("ProviderTimeout", "down", {
          category: "timeout",
          provider: "aihorde",
        }),
      });
    }

    const plan = GatewayRouter.plan({
      requestedModel: "auto",
      stream: true,
      providers,
      configs: [configFor("aihorde", 0), configFor("ollama", 1)],
    });
    expect(plan.candidates.map((c) => c.provider)).not.toContain("aihorde");
    expect(plan.excluded.some((x) => x.provider === "aihorde")).toBe(true);
  });

  it("only offers models the provider actually reported", () => {
    const providers = [fakeProvider("aihorde")];
    // A model the provider did not report must never enter the candidate set,
    // whatever it is called. Nothing here is special-cased by name.
    GatewayModelRegistry.setModels(
      "aihorde",
      modelsFromIds("aihorde", [MODEL], { requiresApiKey: false, supportsStreaming: true })
    );
    const plan = GatewayRouter.plan({
      requestedModel: "auto",
      stream: true,
      providers,
      configs: [configFor("aihorde", 0)],
    });
    expect(plan.candidates.map((c) => c.model)).toEqual([MODEL]);
  });

  it("does not mark a model healthy merely because it appears in a catalogue", () => {
    const model = normalizeModel({ id: MODEL, provider: "aihorde", supportsStreaming: false });
    // Present, but unobserved: never "available" before a real observation.
    expect(model.availability).toBe("unknown");
  });
});
