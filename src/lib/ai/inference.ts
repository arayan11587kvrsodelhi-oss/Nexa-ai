import { db } from "@/db";
import { modelConfigs } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { ProviderType } from "@/types";
import { GenerateOptions, ModelProvider, StreamEvent } from "./types";
import { ProviderRegistry } from "./registry";
import { ProviderError, healthStatusToErrorCode } from "./provider-errors";
import { createProvider, resolveProviderType } from "./providers/factory";
import { DemoSandboxProvider } from "./providers/demo";
import { FreeLLMAPIProvider } from "./providers/freellmapi";

export interface ResolvedInferenceConfig {
  provider: ProviderType;
  /** Endpoint that will be called. Never contains a credential. */
  baseUrl: string;
  modelName: string;
  /** Server-side credential. Never returned by an API route. */
  apiKey?: string;
  temperature: number;
  maxTokens: number;
  source: "database" | "environment";
}

export class InferenceService {
  /**
   * Resolve the effective provider configuration for a user.
   *
   * Precedence is unchanged: the user's active `model_configs` row wins, then
   * the environment defaults. FreeLLMAPI is the exception — its endpoint and
   * API key are server-side environment configuration only, so they are never
   * read from a database row (and never written to one).
   *
   * No network I/O happens here.
   */
  public static async resolveConfig(userId?: string): Promise<ResolvedInferenceConfig> {
    // 1. Check database for the requesting user's active config
    let configRecord: typeof modelConfigs.$inferSelect | null = null;
    try {
      if (userId) {
        const records = await db
          .select()
          .from(modelConfigs)
          .where(and(eq(modelConfigs.isActive, true), eq(modelConfigs.userId, userId)))
          .limit(1);
        if (records.length > 0) {
          configRecord = records[0];
        }
      }
    } catch {
      // If DB error, proceed with default env
    }

    const provider = resolveProviderType(
      configRecord?.provider || process.env.DEFAULT_PROVIDER
    );

    const baseUrl =
      provider === "freellmapi"
        ? (process.env.FREELLMAPI_BASE_URL ?? "").trim()
        : configRecord?.baseUrl || process.env.OLLAMA_BASE_URL || "http://localhost:11434";

    // FreeLLMAPI's model comes from server configuration only. There is
    // deliberately no Ollama-shaped fallback on this branch: a FreeLLMAPI
    // request must never be sent a model id belonging to a different engine
    // (e.g. `llama3.2:3b`), and the provider itself is the source of truth for
    // the ids it will accept.
    const modelName =
      provider === "freellmapi"
        ? configRecord?.modelName?.trim() || (process.env.FREELLMAPI_MODEL ?? "").trim()
        : configRecord?.modelName || process.env.OLLAMA_MODEL || "llama3.2:3b";

    const apiKey =
      provider === "freellmapi"
        ? (process.env.FREELLMAPI_API_KEY ?? "").trim() || undefined
        : configRecord?.apiKey || process.env.API_KEY || undefined;

    return {
      provider,
      baseUrl,
      modelName,
      apiKey,
      temperature: configRecord?.temperature ?? 0.7,
      maxTokens: configRecord?.maxTokens ?? 4096,
      source: configRecord ? "database" : "environment",
    };
  }

  /**
   * The provider identity that will be used, without touching the network.
   * Request routing reads this so a model id is never routed for one provider
   * and then sent to another.
   */
  public static async resolveActiveProviderType(userId?: string): Promise<ProviderType> {
    return (await this.resolveConfig(userId)).provider;
  }

  public static async getActiveProvider(userId?: string): Promise<{
    provider: ModelProvider;
    isDemo: boolean;
    config: {
      provider: string;
      baseUrl: string;
      modelName: string;
      temperature: number;
      maxTokens: number;
    };
  }> {
    const resolved = await this.resolveConfig(userId);

    const baseConfig = {
      provider: resolved.provider,
      baseUrl: resolved.baseUrl,
      modelName: resolved.modelName,
      temperature: resolved.temperature,
      maxTokens: resolved.maxTokens,
    };

    if (resolved.provider === "demo") {
      return {
        provider: new DemoSandboxProvider(),
        isDemo: true,
        config: baseConfig,
      };
    }

    // FreeLLMAPI — a first-class provider, health-checked and model-discovered
    // like Ollama, and the one path where the demo sandbox can NEVER be reached:
    // there is no `ALLOW_DEMO_FALLBACK` branch below. A failure is reported as a
    // normalized ProviderError that the UI explains, so a broken real provider
    // can never be mistaken for a real answer.
    if (resolved.provider === "freellmapi") {
      const adapter = new FreeLLMAPIProvider(resolved.baseUrl, resolved.apiKey);
      const catalog = await adapter.discoverCatalog();

      if (catalog.models.length > 0) {
        ProviderRegistry.setDiscoveredModels("freellmapi", catalog.models);
      }

      if (!catalog.health.ok) {
        throw new ProviderError("freellmapi", healthStatusToErrorCode(catalog.health.status), catalog.health.message);
      }

      return {
        provider: adapter,
        isDemo: false,
        config: {
          ...baseConfig,
          // No configured model → use what the provider actually reported.
          modelName: resolved.modelName || catalog.models[0]?.id || "",
        },
      };
    }

    const provider = createProvider(resolved.provider, {
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
    });

    if (resolved.provider === "ollama" || resolved.provider === "custom") {
      const health = await provider.testConnection();

      if (!health.ok) {
        // DEMO FALLBACK POLICY (unchanged): the canned DemoSandboxProvider is
        // reachable ONLY when the operator sets ALLOW_DEMO_FALLBACK=true
        // explicitly. There is no NODE_ENV-based implicit fallback, in any
        // environment. A deployment whose Ollama is unreachable and has not
        // opted in gets a clear, honest provider-unavailable error — never
        // silent canned output.
        if (process.env.ALLOW_DEMO_FALLBACK === "true") {
          return {
            provider: new DemoSandboxProvider(),
            isDemo: true,
            config: {
              ...baseConfig,
              provider: "demo",
              modelName: "nexa-sandbox-demo",
            },
          };
        }

        throw new ProviderError(
          "ollama",
          healthStatusToErrorCode(health.status),
          `Local AI engine unavailable: Could not connect to Ollama at ${resolved.baseUrl}. Ensure Ollama is running ('ollama serve') or switch provider in Settings.`
        );
      }
    }

    return {
      provider,
      isDemo: false,
      config: baseConfig,
    };
  }

  public static async streamChat(
    userId: string,
    options: GenerateOptions,
    emitEvent: (event: StreamEvent) => void
  ): Promise<{
    fullText: string;
    reasoningText?: string;
    latencyMs: number;
    isDemo: boolean;
    /** The model id actually sent to the provider. */
    modelUsed: string;
    /** The provider that actually served the request. */
    providerId: string;
  }> {
    const { provider, isDemo, config } = await this.getActiveProvider(userId);

    const modelUsed = isDemo
      ? "nexa-sandbox-demo"
      : this.resolveModelForProvider(provider, options.model, config.modelName);

    const result = await provider.generateStream(
      {
        ...options,
        model: modelUsed,
      },
      emitEvent
    );

    return {
      ...result,
      isDemo,
      modelUsed,
      providerId: provider.id,
    };
  }

  /**
   * Pick the model id to send.
   *
   * For most providers the requested model wins, falling back to the configured
   * default (unchanged behaviour). For FreeLLMAPI, a model id that the provider
   * itself never advertised — for example one the local profile router picked
   * for Ollama — is never forwarded: the configured/discovered FreeLLMAPI model
   * is used instead.
   */
  private static resolveModelForProvider(
    provider: ModelProvider,
    requestedModel: string | undefined,
    configuredModel: string
  ): string {
    const requested = requestedModel?.trim() ?? "";
    const fallback = configuredModel.trim();

    if (provider.id === "freellmapi") {
      if (requested && ProviderRegistry.getDiscoveredModel("freellmapi", requested)) {
        return requested;
      }
      return fallback || requested;
    }

    return requested || fallback;
  }
}
