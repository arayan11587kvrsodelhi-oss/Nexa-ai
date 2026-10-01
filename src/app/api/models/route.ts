import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { modelConfigs } from "@/db/schema";
import {
  DiscoveredModel,
  ModelRegistry,
  PROFILE_METADATA,
  ProviderRegistry,
} from "@/lib/ai/registry";
import { ProviderConnectionResult } from "@/lib/ai/types";
import {
  createProvider,
  isProviderType,
  PROVIDER_TYPES,
  resolveProviderType,
} from "@/lib/ai/providers/factory";
import { FreeLLMAPIProvider } from "@/lib/ai/providers/freellmapi";
import { NexaGateway } from "@/lib/gateway/gateway";
import { validateProviderUrl } from "@/lib/gateway/config";
import { requireUser } from "@/lib/auth/guard";
import { toErrorResponse, ApiError } from "@/lib/api/errors";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);

    // 1. Get this user's active config from the database when it is reachable.
    //    A database outage must not take the model picker down with it: the
    //    environment defaults are a complete, honest answer on their own.
    let activeConfig: typeof modelConfigs.$inferSelect | null = null;
    let databaseReachable = true;
    try {
      const configs = await db
        .select()
        .from(modelConfigs)
        .where(and(eq(modelConfigs.isActive, true), eq(modelConfigs.userId, user.id)))
        .limit(1);
      if (configs.length > 0) activeConfig = configs[0];
    } catch {
      databaseReachable = false;
    }

    const providerType = resolveProviderType(
      activeConfig?.provider || process.env.DEFAULT_PROVIDER
    );
    // FreeLLMAPI's endpoint and model are server-side environment configuration
    // only, and its model is never defaulted to an Ollama model id.
    const baseUrl =
      providerType === "freellmapi"
        ? (process.env.FREELLMAPI_BASE_URL ?? "").trim()
        : activeConfig?.baseUrl || process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    const configuredModelName =
      providerType === "freellmapi"
        ? activeConfig?.modelName?.trim() || (process.env.FREELLMAPI_MODEL ?? "").trim()
        : activeConfig?.modelName || process.env.OLLAMA_MODEL || "llama3.2:3b";

    // 2. Probe the provider for real. Never assume it is reachable.
    let reachability: ProviderConnectionResult = { ok: false, message: "Uninitialized" };
    /** Models the provider actually reported (never a fabricated list). */
    let discoveredModels: DiscoveredModel[] = [];

    if (providerType === "demo") {
      reachability = {
        ok: true,
        message: "NEXA Demo Sandbox active (simulated preview engine)",
        models: ["nexa-sandbox-demo"],
        latencyMs: 1,
      };
    } else if (providerType === "freellmapi") {
      // A single GET /v1/models call serves as both the health probe and the
      // discovery call.
      const adapter = new FreeLLMAPIProvider(baseUrl);
      const catalog = await adapter.discoverCatalog();
      reachability = catalog.health;
      discoveredModels = catalog.models;
      if (catalog.models.length > 0) {
        ProviderRegistry.setDiscoveredModels("freellmapi", catalog.models);
      }
    } else {
      const adapter = createProvider(providerType, {
        baseUrl,
        apiKey: activeConfig?.apiKey || undefined,
      });
      reachability = await adapter.testConnection();
    }

    // The gateway is what actually serves a request now, so the model picker
    // must not describe a provider the request path would never use. This is
    // additive: `activeConfig` keeps its exact previous shape for existing UI
    // consumers, and `gateway` is the honest view of what will really answer.
    const gateway = await NexaGateway.health().catch((error: unknown) => {
      console.warn("[nexa] gateway health unavailable:", error);
      return null;
    });

    return NextResponse.json({
      activeConfig: {
        provider: providerType,
        baseUrl,
        modelName: configuredModelName || discoveredModels[0]?.id || "",
        temperature: activeConfig?.temperature ?? 0.7,
        maxTokens: activeConfig?.maxTokens ?? 4096,
        isDemo: providerType === "demo",
        source: activeConfig ? "database" : "environment",
      },
      databaseReachable,
      reachability,
      /**
       * What the gateway can actually reach right now. `ok: false` with a
       * message is the honest answer when nothing is configured — the UI must
       * not present an unconfigured deployment as a working engine.
       */
      gateway: gateway
        ? {
            ok: gateway.ok,
            status: gateway.status,
            message: gateway.message,
            providerOrder: gateway.providerOrder,
            models: gateway.models,
            providers: gateway.providers.map((provider) => ({
              provider: provider.provider,
              status: provider.status,
              ok: provider.ok,
              message: provider.message,
              latencyMs: provider.latencyMs,
            })),
          }
        : null,
      models: ModelRegistry.getAll(),
      /** Provider identities and what each one can actually do. No secrets. */
      providers: ProviderRegistry.getAll(),
      /** Models reported by the active provider's own discovery endpoint. */
      discoveredModels,
      profiles: PROFILE_METADATA,
    });
  } catch (err: unknown) {
    return toErrorResponse(err, { request });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw ApiError.badRequest("A JSON body is required.");
    }
    const { provider, baseUrl, modelName, apiKey, temperature, maxTokens } = body;

    if (provider !== undefined && provider !== null && !isProviderType(provider)) {
      throw ApiError.badRequest(
        `Unsupported provider '${String(provider)}'. Supported providers: ${PROVIDER_TYPES.join(", ")}.`
      );
    }
    const providerType = resolveProviderType(provider);

    // FreeLLMAPI is configured on the server, not per user: its endpoint is a
    // request-forgery surface and its key must never be persisted in plaintext
    // model metadata.
    if (providerType === "freellmapi" && (baseUrl || apiKey)) {
      throw ApiError.badRequest(
        "The FreeLLMAPI endpoint and API key are server-side configuration (FREELLMAPI_BASE_URL / FREELLMAPI_API_KEY) and cannot be set per user."
      );
    }

    // Phase 5.6 — SSRF, and a *stored* one.
    //
    // A user-supplied `baseUrl` used to be persisted verbatim here, and is then
    // read back and fetched by `GET /api/models` (on every model-picker page
    // load) and by `/api/chat` on every message. One config write therefore
    // turned every later request into a server-side request to an address the
    // user chose — cloud metadata, an internal admin port, anything reachable
    // from the host. That is strictly worse than the transient case closed in
    // Phase 5.5, because it persists and re-fires.
    //
    // The stored value is validated with the *existing* `validateProviderUrl`
    // rather than a new helper, so a user-configured endpoint is held to
    // exactly the same policy the gateway already applies to operator-configured
    // ones: http/https only, no embedded credentials, never a cloud-metadata
    // host, and never a private/loopback/link-local target unless the operator
    // has explicitly set `NEXA_ALLOW_PRIVATE_PROVIDER_HOSTS=true` (or is running
    // in development, where reaching a local Ollama is the intended workflow).
    if (typeof baseUrl === "string" && baseUrl.trim()) {
      const check = validateProviderUrl(baseUrl, { label: "provider endpoint" });
      if (!check.ok) {
        throw ApiError.badRequest(check.reason);
      }
    }

    // Deactivate this user's previous active config only.
    await db
      .update(modelConfigs)
      .set({ isActive: false })
      .where(and(eq(modelConfigs.isActive, true), eq(modelConfigs.userId, user.id)));

    const resolvedModelName =
      (typeof modelName === "string" && modelName.trim()) ||
      (providerType === "freellmapi" ? (process.env.FREELLMAPI_MODEL ?? "").trim() : "llama3.2:3b");

    const id = `cfg_${Date.now()}`;
    const [inserted] = await db
      .insert(modelConfigs)
      .values({
        id,
        userId: user.id,
        provider: providerType,
        baseUrl:
          providerType === "freellmapi"
            ? (process.env.FREELLMAPI_BASE_URL ?? "").trim()
            : baseUrl || "http://localhost:11434",
        modelName: resolvedModelName || undefined,
        // Credentials are only stored for the existing bring-your-own-endpoint
        // providers. FreeLLMAPI credentials stay in the server environment.
        apiKey: providerType === "freellmapi" ? null : apiKey || null,
        temperature: temperature !== undefined ? Number(temperature) : 0.7,
        maxTokens: maxTokens !== undefined ? Number(maxTokens) : 4096,
        isActive: true,
        isDefault: true,
      })
      .returning();

    return NextResponse.json({
      config: { ...inserted, apiKey: undefined, hasApiKey: Boolean(inserted.apiKey) },
      message: "Model configuration updated successfully.",
    });
  } catch (err: unknown) {
    return toErrorResponse(err, { request: req });
  }
}
