import { Attachment, ModelProfile, ProviderType } from "@/types";
import { ModelRegistry, ProviderRegistry } from "./registry";
import { ModelProvider } from "./types";
import { createProvider, resolveProviderType } from "./providers/factory";

export interface RoutingDecision {
  profile: ModelProfile;
  modelId: string;
  reason: string;
  isAutomatic: boolean;
  capabilities: {
    supportsTools: boolean;
    supportsVision: boolean;
    /**
     * `0` means the provider did not report a context window. It is never
     * guessed, and callers must treat 0 as "unknown".
     */
    contextWindow: number;
  };
}

export class ModelRouter {
  /**
   * Route a request.
   *
   * `activeProvider` is the provider actually configured for this request (see
   * `InferenceService.resolveActiveProviderType`). The parameter is optional,
   * so existing callers keep the previous behaviour exactly.
   *
   * When it is `freellmapi`, the model id comes from the models FreeLLMAPI
   * itself reported. The profile heuristic still runs (it decides FAST / CODING /
   * … for the UI) but it can never move a request to another provider, and
   * FreeLLMAPI is never selected unless the configuration selected it.
   */
  public static route(
    prompt: string,
    requestedProfile?: ModelProfile,
    requestedModel?: string,
    attachments: Attachment[] = [],
    activeProvider?: ProviderType
  ): RoutingDecision {
    if (activeProvider === "freellmapi") {
      return this.routeWithinFreellmapi(prompt, requestedProfile, requestedModel, attachments);
    }
    return this.routeWithinRegistry(prompt, requestedProfile, requestedModel, attachments);
  }

  /**
   * Explicit provider selection.
   *
   * Never falls back: an explicit request returns that provider, and without a
   * request the configured default (`DEFAULT_PROVIDER`, else Ollama) is used.
   * The simulated sandbox is only ever returned when it is named explicitly.
   */
  public static selectProvider(
    requestedProvider?: ProviderType,
    overrides: { baseUrl?: string; apiKey?: string } = {}
  ): { provider: ModelProvider; providerId: ProviderType; explicit: boolean; reason: string } {
    if (requestedProvider) {
      return {
        provider: createProvider(requestedProvider, overrides),
        providerId: requestedProvider,
        explicit: true,
        reason: `Provider '${requestedProvider}' was selected explicitly.`,
      };
    }
    const configured = resolveProviderType(process.env.DEFAULT_PROVIDER, "ollama");
    return {
      provider: createProvider(configured, overrides),
      providerId: configured,
      explicit: false,
      reason: `No provider was requested; using the configured default '${configured}'.`,
    };
  }

  /** Routing when FreeLLMAPI is the configured provider. */
  private static routeWithinFreellmapi(
    prompt: string,
    requestedProfile: ModelProfile | undefined,
    requestedModel: string | undefined,
    attachments: Attachment[]
  ): RoutingDecision {
    // The profile heuristic still runs, but only for the profile label.
    const heuristic = this.routeWithinRegistry(prompt, requestedProfile, requestedModel, attachments);
    const catalog = ProviderRegistry.getDiscoveredModels("freellmapi");
    const explicitModel =
      requestedModel && catalog.some((m) => m.id === requestedModel) ? requestedModel : undefined;
    const chosen = explicitModel ? catalog.find((m) => m.id === explicitModel) : catalog[0];

    if (!chosen) {
      return {
        profile: heuristic.profile,
        modelId: "",
        reason:
          "Active provider is FreeLLMAPI but it has not reported any models yet. The configured FreeLLMAPI model name will be used.",
        isAutomatic: true,
        capabilities: { supportsTools: false, supportsVision: false, contextWindow: 0 },
      };
    }

    return {
      profile: heuristic.profile,
      modelId: chosen.id,
      reason: explicitModel
        ? `Active provider is FreeLLMAPI; using the explicitly requested model '${chosen.id}'.`
        : `Active provider is FreeLLMAPI; using the first model it reported ('${chosen.id}').`,
      isAutomatic: !explicitModel,
      capabilities: {
        // null means "the provider did not advertise this" — reported as false
        // rather than assumed true.
        supportsTools: chosen.supportsTools ?? false,
        supportsVision: chosen.supportsVision ?? false,
        contextWindow: chosen.contextWindow ?? 0,
      },
    };
  }

  private static routeWithinRegistry(
    prompt: string,
    requestedProfile?: ModelProfile,
    requestedModel?: string,
    attachments: Attachment[] = []
  ): RoutingDecision {
    // 1. If user explicitly provided a model and it's registered, respect it
    if (requestedModel) {
      const descriptor = ModelRegistry.getById(requestedModel);
      if (descriptor) {
        return {
          profile: descriptor.profile,
          modelId: descriptor.id,
          reason: `User explicitly selected model '${descriptor.name}'`,
          isAutomatic: false,
          capabilities: {
            supportsTools: descriptor.supportsTools,
            supportsVision: descriptor.supportsVision,
            contextWindow: descriptor.contextWindow,
          },
        };
      }
    }

    // 2. If user explicitly provided a profile, route to profile's recommended model
    if (requestedProfile && requestedProfile !== ("AUTO" as unknown)) {
      const modelId = ModelRegistry.getRecommendedForProfile(requestedProfile);
      const descriptor = ModelRegistry.getById(modelId);
      return {
        profile: requestedProfile,
        modelId,
        reason: `Routed to recommended model for profile '${requestedProfile}'`,
        isAutomatic: false,
        capabilities: {
          supportsTools: descriptor?.supportsTools ?? true,
          supportsVision: descriptor?.supportsVision ?? false,
          contextWindow: descriptor?.contextWindow ?? 32768,
        },
      };
    }

    // 3. Automatic routing based on content, attachments, and context size
    const lower = prompt.toLowerCase();
    const hasImages = attachments.some(
      (a) => a.mimeType.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(a.name)
    );
    const hasLargeFiles =
      attachments.some((a) => a.size > 200_000) || prompt.length > 10_000;

    // Vision detection
    if (hasImages) {
      const modelId = ModelRegistry.getRecommendedForProfile("VISION");
      const descriptor = ModelRegistry.getById(modelId);
      return {
        profile: "VISION",
        modelId,
        reason: "Detected image attachment — selected vision-capable profile",
        isAutomatic: true,
        capabilities: {
          supportsTools: descriptor?.supportsTools ?? false,
          supportsVision: true,
          contextWindow: descriptor?.contextWindow ?? 131072,
        },
      };
    }

    // Long context detection
    if (hasLargeFiles) {
      const modelId = ModelRegistry.getRecommendedForProfile("LONG_CONTEXT");
      const descriptor = ModelRegistry.getById(modelId);
      return {
        profile: "LONG_CONTEXT",
        modelId,
        reason: "Detected large document / high-volume payload — selected extended context profile",
        isAutomatic: true,
        capabilities: {
          supportsTools: descriptor?.supportsTools ?? true,
          supportsVision: false,
          contextWindow: descriptor?.contextWindow ?? 131072,
        },
      };
    }

    // Coding detection
    const codingKeywords = [
      "code", "function", "class", "bug", "debug", "refactor", "syntax",
      "typescript", "javascript", "python", "sql", "git", "api", "endpoint",
      "regex", "react", "next.js", "docker", "compile", "exception", "async", "await",
      "component", "hook", "schema", "database", "query", "css", "html"
    ];
    const isCoding = codingKeywords.some((kw) =>
      new RegExp(`\\b${kw}\\b`, "i").test(lower)
    );
    if (isCoding) {
      const modelId = ModelRegistry.getRecommendedForProfile("CODING");
      const descriptor = ModelRegistry.getById(modelId);
      return {
        profile: "CODING",
        modelId,
        reason: "Detected programming or debugging context — selected code optimization profile",
        isAutomatic: true,
        capabilities: {
          supportsTools: descriptor?.supportsTools ?? true,
          supportsVision: false,
          contextWindow: descriptor?.contextWindow ?? 131072,
        },
      };
    }

    // Reasoning detection
    const reasoningKeywords = [
      "prove", "theorem", "deduce", "logic", "solve step by step",
      "puzzle", "algorithm", "complex reasoning", "derive", "philosophy",
      "calculate probabilities", "counterfactual", "formal verification"
    ];
    const isReasoning = reasoningKeywords.some((kw) =>
      new RegExp(`\\b${kw}\\b`, "i").test(lower)
    );
    if (isReasoning) {
      const modelId = ModelRegistry.getRecommendedForProfile("REASONING");
      const descriptor = ModelRegistry.getById(modelId);
      return {
        profile: "REASONING",
        modelId,
        reason: "Detected formal logic or analytical puzzle — selected reasoning profile",
        isAutomatic: true,
        capabilities: {
          supportsTools: descriptor?.supportsTools ?? true,
          supportsVision: false,
          contextWindow: descriptor?.contextWindow ?? 65536,
        },
      };
    }

    // Fast reply detection for short questions
    if (prompt.trim().length > 0 && prompt.trim().length < 40 && !prompt.includes("?")) {
      const modelId = ModelRegistry.getRecommendedForProfile("FAST");
      const descriptor = ModelRegistry.getById(modelId);
      return {
        profile: "FAST",
        modelId,
        reason: "Brief conversational input — selected low-latency profile",
        isAutomatic: true,
        capabilities: {
          supportsTools: descriptor?.supportsTools ?? false,
          supportsVision: false,
          contextWindow: descriptor?.contextWindow ?? 131072,
        },
      };
    }

    // Default to balanced
    const modelId = ModelRegistry.getRecommendedForProfile("BALANCED");
    const descriptor = ModelRegistry.getById(modelId);
    return {
      profile: "BALANCED",
      modelId,
      reason: "Standard conversational inquiry — selected balanced profile",
      isAutomatic: true,
      capabilities: {
        supportsTools: descriptor?.supportsTools ?? true,
        supportsVision: false,
        contextWindow: descriptor?.contextWindow ?? 131072,
      },
    };
  }
}
