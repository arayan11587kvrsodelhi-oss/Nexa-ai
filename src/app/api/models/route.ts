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
      activeConfig?.provider || process.env.DEFAULT_PROVIDER || "ollama"
    );
    // FreeLLMAPI's endpoint is server-side environment configuration only.
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
    const providerType = resolveProviderType(provider, "ollama");

    // FreeLLMAPI is configured on the server, not per user: its endpoint is a
    // request-forgery surface and its key must never be persisted in plaintext
    // model metadata.
    if (providerType === "freellmapi" && (baseUrl || apiKey)) {
      throw ApiError.badRequest(
        "The FreeLLMAPI endpoint and API key are server-side configuration (FREELLMAPI_BASE_URL / FREELLMAPI_API_KEY) and cannot be set per user."
      );
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
