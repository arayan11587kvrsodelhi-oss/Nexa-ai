/**
 * NEXA AI Gateway — provider/model health store.
 *
 * Design rules:
 *
 *  1. Only a real observation creates a record. `discovered` and `configured`
 *     are states, not health claims, and a model is never `healthy` because it
 *     appeared in a catalog.
 *  2. Health survives a restart and is shared between serverless instances by
 *     being written to the existing PostgreSQL database. The in-process map is
 *     the fast path; the database is the durable one. If the database is
 *     unavailable the gateway keeps working from memory — a database outage
 *     must not be reported as "every model is healthy".
 *  3. Failure categories are preserved (timeout / rate_limited /
 *     authentication_error / provider_error / unavailable) so the router can
 *     report exactly why a model was skipped.
 */
import { db } from "@/db";
import { providerHealth } from "@/db/schema";
import { desc, gte } from "drizzle-orm";
import type { GatewayError, GatewayErrorCategory } from "./errors";
import { envInt } from "./config";
import { UNHEALTHY_STATUSES, type GatewayHealthStatus, type GatewayProviderId } from "./types";

export interface HealthRecord {
  key: string;
  provider: GatewayProviderId;
  /** null = a provider-level observation. */
  modelId: string | null;
  status: GatewayHealthStatus;
  ok: boolean;
  latencyMs: number | null;
  errorCategory: GatewayErrorCategory | null;
  message: string;
  checkedAt: string;
  consecutiveFailures: number;
}

/** A failure is trusted for this long before the router may retry the target. */
export const HEALTH_TTL_MS = 5 * 60_000;
/** Authentication failures are not re-probed aggressively. */
export const AUTH_FAILURE_TTL_MS = 30 * 60_000;
/** Two consecutive failures quarantine a target until a success clears it. */
export const FAILURE_THRESHOLD = 2;

function ttlFor(status: GatewayHealthStatus): number {
  const configured = envInt(
    "NEXA_GATEWAY_MODEL_HEALTH_TTL_MS",
    HEALTH_TTL_MS,
    1_000,
    24 * 60 * 60_000
  );
  return status === "authentication_error" ? Math.max(configured, AUTH_FAILURE_TTL_MS) : configured;
}

/** Fold a failure category into the health vocabulary. */
export function statusFromErrorCategory(category: GatewayErrorCategory): GatewayHealthStatus {
  switch (category) {
    case "timeout":
      return "timeout";
    case "rate_limit":
      return "rate_limited";
    case "authentication_failure":
      return "authentication_error";
    case "invalid_model":
    case "permanent_configuration_failure":
      return "unavailable";
    default:
      // temporary_upstream_failure / unknown / anything else.
      return "provider_error";
  }
}

export function healthKey(provider: GatewayProviderId, modelId?: string | null): string {
  return `${provider}::${modelId ?? "*"}`;
}

/**
 * In-process + PostgreSQL health store.
 *
 * Every method is safe to call from a route handler: database work is
 * best-effort and never throws.
 */
export class GatewayHealthStore {
  private static memory = new Map<string, HealthRecord>();
  private static hydrated = false;
  private static durableLayerAvailable = true;

  public static reset(): void {
    this.memory.clear();
    this.hydrated = false;
    this.durableLayerAvailable = true;
  }

  public static get(provider: GatewayProviderId, modelId?: string | null): HealthRecord | undefined {
    return this.memory.get(healthKey(provider, modelId));
  }

  /** Status of the most recent provider-level observation. */
  public static providerStatus(provider: GatewayProviderId): GatewayHealthStatus {
    return this.memory.get(healthKey(provider, null))?.status ?? "configured";
  }

  public static snapshot(): HealthRecord[] {
    return Array.from(this.memory.values());
  }

  /** Record a successful probe or completed generation. Clears the streak. */
  public static async recordSuccess(input: {
    provider: GatewayProviderId;
    modelId?: string | null;
    latencyMs: number;
    message?: string;
  }): Promise<HealthRecord> {
    return this.write({
      provider: input.provider,
      modelId: input.modelId ?? null,
      status: "healthy",
      ok: true,
      latencyMs: input.latencyMs,
      errorCategory: null,
      message: input.message ?? "Provider responded successfully.",
      consecutiveFailures: 0,
    });
  }

  /** Record a classified failure. Never called for user-cancelled requests. */
  public static async recordError(input: {
    provider: GatewayProviderId;
    modelId?: string | null;
    error: GatewayError;
    latencyMs?: number;
  }): Promise<HealthRecord | null> {
    if (!input.error.isProviderHealthFailure) return null;
    const previous = this.memory.get(healthKey(input.provider, input.modelId ?? null));
    return this.write({
      provider: input.provider,
      modelId: input.modelId ?? null,
      status: statusFromErrorCategory(input.error.category),
      ok: false,
      latencyMs: input.latencyMs ?? null,
      errorCategory: input.error.category,
      message: input.error.message,
      consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
    });
  }

  /** Mark a model the provider itself rejected as unknown/unavailable. */
  public static async recordInvalidModel(
    provider: GatewayProviderId,
    modelId: string,
    message: string
  ): Promise<HealthRecord> {
    return this.write({
      provider,
      modelId,
      status: "unavailable",
      ok: false,
      latencyMs: null,
      errorCategory: "invalid_model",
      message,
      consecutiveFailures: FAILURE_THRESHOLD,
    });
  }

  /**
   * Why a target must not be routed to, or null when it is eligible.
   *
   * Single source of truth for the router, so a skip reason can be reported
   * verbatim instead of guessed.
   */
  public static unhealthyReason(
    provider: GatewayProviderId,
    modelId?: string | null,
    now = Date.now()
  ): string | null {
    const candidates: HealthRecord[] = [];
    const modelRecord = this.memory.get(healthKey(provider, modelId ?? null));
    if (modelRecord) candidates.push(modelRecord);
    if (modelId) {
      const providerRecord = this.memory.get(healthKey(provider, null));
      if (providerRecord) candidates.push(providerRecord);
    }

    const failing = candidates
      .filter((record) => !record.ok)
      .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0];
    if (!failing) return null;

    const streak = failing.consecutiveFailures >= FAILURE_THRESHOLD;
    const age = now - Date.parse(failing.checkedAt);
    if (!streak && age > ttlFor(failing.status)) return null;

    const scope = modelId ? ` for model ${modelId}` : "";
    return streak
      ? `${provider}${scope} failed ${failing.consecutiveFailures} consecutive times (${failing.status}).`
      : `${provider}${scope} reported ${failing.status} ${Math.max(1, Math.round(age / 1000))}s ago.`;
  }

  /** True when a target is known-bad right now. */
  public static isKnownUnhealthy(
    provider: GatewayProviderId,
    modelId?: string | null,
    now = Date.now()
  ): boolean {
    return this.unhealthyReason(provider, modelId, now) !== null;
  }

  private static async write(input: {
    provider: GatewayProviderId;
    modelId: string | null;
    status: GatewayHealthStatus;
    ok: boolean;
    latencyMs: number | null;
    errorCategory: GatewayErrorCategory | null;
    message: string;
    consecutiveFailures: number;
  }): Promise<HealthRecord> {
    const checkedAt = new Date().toISOString();
    const record: HealthRecord = {
      key: healthKey(input.provider, input.modelId),
      ...input,
      checkedAt,
    };
    this.memory.set(record.key, record);
    await this.persist(record);
    return record;
  }

  /** Best-effort durable copy. Never throws. */
  private static async persist(record: HealthRecord): Promise<void> {
    if (!this.durableLayerAvailable) return;
    try {
      await db
        .insert(providerHealth)
        .values({
          id: record.key,
          providerId: record.provider,
          modelId: record.modelId,
          status: record.status,
          ok: record.ok,
          latencyMs: record.latencyMs,
          errorCategory: record.errorCategory,
          message: record.message,
          consecutiveFailures: record.consecutiveFailures,
          checkedAt: new Date(record.checkedAt),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: providerHealth.id,
          set: {
            status: record.status,
            ok: record.ok,
            latencyMs: record.latencyMs,
            errorCategory: record.errorCategory,
            message: record.message,
            consecutiveFailures: record.consecutiveFailures,
            checkedAt: new Date(record.checkedAt),
            updatedAt: new Date(),
          },
        });
    } catch (err) {
      // The durable layer is optional: memory still holds the truth for this
      // instance. Log once per process so a missing migration is obvious.
      if (this.durableLayerAvailable) {
        this.durableLayerAvailable = false;
        console.warn(
          "[nexa.gateway] provider_health persistence unavailable; health is in-memory for this instance:",
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  /**
   * Hydrate the in-process map from the durable store (at most once per
   * process). A cold serverless instance then inherits recent observations
   * instead of believing every model is untested.
   */
  public static async hydrate(maxAgeMs = AUTH_FAILURE_TTL_MS): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    if (!this.durableLayerAvailable) return;
    try {
      const rows = await db
        .select()
        .from(providerHealth)
        .where(gte(providerHealth.checkedAt, new Date(Date.now() - maxAgeMs)))
        .orderBy(desc(providerHealth.checkedAt))
        .limit(200);
      for (const row of rows) {
        if (this.memory.has(row.id)) continue;
        this.memory.set(row.id, {
          key: row.id,
          provider: row.providerId as GatewayProviderId,
          modelId: row.modelId,
          status: row.status as GatewayHealthStatus,
          ok: row.ok,
          latencyMs: row.latencyMs,
          errorCategory: row.errorCategory as GatewayErrorCategory | null,
          message: row.message ?? "",
          checkedAt: (row.checkedAt instanceof Date ? row.checkedAt : new Date()).toISOString(),
          consecutiveFailures: row.consecutiveFailures,
        });
      }
    } catch {
      // No durable health available; memory-only mode continues.
      this.durableLayerAvailable = false;
    }
  }

  /** True when a status means "do not route here". */
  public static isUnhealthyStatus(status: GatewayHealthStatus): boolean {
    return UNHEALTHY_STATUSES.includes(status);
  }
}
