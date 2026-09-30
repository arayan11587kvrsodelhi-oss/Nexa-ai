/**
 * NEXA AI Gateway — deterministic auto routing.
 *
 * NEXA owns `model: "auto"`. The rules are deliberately boring so a decision can
 * be reproduced and explained:
 *
 *  1. Only *configured* providers take part (a provider whose configuration is
 *     unusable, or that needs a credential it does not have, is out).
 *  2. A provider or model with a recent recorded failure is excluded, and the
 *     exclusion is reported with the recorded reason. Nothing is silently
 *     downgraded to "healthy".
 *  3. Only models the provider itself reported are candidates — plus, for an
 *     explicitly requested model, that exact id (the provider may accept a model
 *     it does not list; NEXA does not pretend it verified it).
 *  4. Ordering is a sort key, not a lottery: provider priority (from
 *     NEXA_PROVIDER_ORDER), then the operator's preferred model, then known
 *     incremental streaming support, then the model id. Ties break on the id.
 *  5. The chain is bounded, and it is recorded in the response metadata, so a
 *     client can see which provider/model answered and what was tried first.
 */
import { envInt, type GatewayProviderConfig } from "./config";
import { GatewayError } from "./errors";
import { GatewayHealthStore } from "./health";
import { GatewayModelRegistry } from "./registry";
import {
  GATEWAY_PROVIDER_IDS,
  type AIProvider,
  type GatewayProviderId,
  type ModelInfo,
} from "./types";

export interface RouteCandidate {
  provider: GatewayProviderId;
  model: string;
  reason: string;
  /** True when the adapter delivers incremental events for this model. */
  incrementalStreaming: boolean | null;
}

export interface RouteExclusion {
  provider: GatewayProviderId;
  model: string | null;
  reason: string;
}

export interface RoutePlan {
  strategy: "explicit" | "auto";
  requestedModel: string;
  candidates: RouteCandidate[];
  reason: string;
  excluded: RouteExclusion[];
}

export interface RouteInput {
  requestedModel: string;
  /** True when the caller wants incremental delivery. */
  stream: boolean;
  providers: AIProvider[];
  configs: GatewayProviderConfig[];
  /** Bounded chain length. Defaults to NEXA_GATEWAY_MAX_CANDIDATES (4). */
  maxCandidates?: number;
}

/** Deterministic ordering weight for a candidate. Lower sorts first. */
interface Weighted {
  candidate: RouteCandidate;
  weight: number[];
}

function weightKey(input: Weighted): string {
  return input.weight.map((n) => n.toString().padStart(6, "0")).join("|");
}

function unverifiedModel(provider: AIProvider, id: string): ModelInfo {
  return {
    id,
    provider: provider.id,
    displayName: id,
    capabilities: { streaming: null, tools: null, vision: null, embeddings: null },
    contextLength: null,
    streaming: null,
    availability: "unknown",
    requiresApiKey: provider.requiresApiKey,
    lastHealthCheck: null,
    discoveredAt: new Date().toISOString(),
    metadata: { unverified: true },
  };
}

export class GatewayRouter {
  /**
   * Build the ordered candidate chain for one request.
   *
   * Throws `GatewayError(ModelUnavailable)` when nothing is eligible, listing
   * exactly why each target was skipped.
   */
  public static plan(input: RouteInput): RoutePlan {
    const requested = (input.requestedModel ?? "").trim();
    const auto = requested.length === 0 || requested.toLowerCase() === "auto";
    const strategy: RoutePlan["strategy"] = auto ? "auto" : "explicit";
    const pinned = auto
      ? { provider: undefined, model: "" }
      : GatewayModelRegistry.parseModelRef(requested, GATEWAY_PROVIDER_IDS);

    const excluded: RouteExclusion[] = [];
    const weighted: Weighted[] = [];
    const configById = new Map(input.configs.map((config) => [config.id, config]));
    const maxCandidates = input.maxCandidates ?? envInt("NEXA_GATEWAY_MAX_CANDIDATES", 4, 1, 12);

    for (const provider of input.providers) {
      const config = configById.get(provider.id);
      const priority = config?.priority ?? GATEWAY_PROVIDER_IDS.indexOf(provider.id);

      // An explicit pin restricts the chain to the requested provider.
      if (pinned.provider && pinned.provider !== provider.id) continue;

      const issue = provider.configurationIssue();
      if (issue) {
        excluded.push({ provider: provider.id, model: null, reason: issue });
        continue;
      }
      if (provider.requiresApiKey && !config?.apiKey) {
        excluded.push({
          provider: provider.id,
          model: null,
          reason: `${provider.id} requires a credential and none is configured.`,
        });
        continue;
      }
      const providerUnhealthy = GatewayHealthStore.unhealthyReason(provider.id, null);
      if (providerUnhealthy) {
        excluded.push({ provider: provider.id, model: null, reason: providerUnhealthy });
        continue;
      }

      const discovered = GatewayModelRegistry.modelsFor(provider.id);
      const models = auto
        ? discovered
        : [
            discovered.find((model) => model.id === pinned.model) ??
              unverifiedModel(provider, pinned.model),
          ];

      if (models.length === 0) {
        excluded.push({
          provider: provider.id,
          model: null,
          reason: `${provider.id} reported no models, so nothing can be routed to it.`,
        });
        continue;
      }

      for (const model of models) {
        const unhealthy = GatewayHealthStore.unhealthyReason(provider.id, model.id);
        if (unhealthy) {
          excluded.push({ provider: provider.id, model: model.id, reason: unhealthy });
          continue;
        }
        const incrementalStreaming = model.capabilities.streaming;
        const isPreferred = Boolean(config?.preferredModel && config.preferredModel === model.id);
        weighted.push({
          candidate: {
            provider: provider.id,
            model: model.id,
            reason: candidateReason({
              auto,
              provider: provider.id,
              model: model.id,
              isPreferred,
              incrementalStreaming,
              unverified: model.metadata.unverified === true,
            }),
            incrementalStreaming,
          },
          weight: [
            priority,
            // The operator's preferred model for this provider wins ties.
            isPreferred ? 0 : 1,
            // Prefer providers that deliver tokens incrementally, but never
            // exclude single-chunk providers: the client still receives the
            // complete text, just in one chunk.
            input.stream
              ? incrementalStreaming === true
                ? 0
                : incrementalStreaming === false
                  ? 2
                  : 1
              : 0,
          ],
        });
      }
    }

    weighted.sort(
      (a, b) =>
        weightKey(a).localeCompare(weightKey(b)) ||
        a.candidate.provider.localeCompare(b.candidate.provider) ||
        a.candidate.model.localeCompare(b.candidate.model)
    );

    const candidates = weighted.slice(0, maxCandidates).map((entry) => entry.candidate);
    if (candidates.length === 0) {
      throw new GatewayError("ModelUnavailable", noCandidateMessage(requested, excluded), {
        category: "temporary_upstream_failure",
        provider: "gateway",
      });
    }

    return {
      strategy,
      requestedModel: requested || "auto",
      candidates,
      reason:
        strategy === "auto"
          ? `Deterministic NEXA routing: providers in configured priority order, unhealthy targets excluded, ${candidates.length} candidate(s).`
          : `Explicit request for '${requested}'; NEXA keeps it first and only falls back on a transient provider failure.`,
      excluded,
    };
  }
}

function candidateReason(input: {
  auto: boolean;
  provider: GatewayProviderId;
  model: string;
  isPreferred: boolean;
  incrementalStreaming: boolean | null;
  unverified: boolean;
}): string {
  const parts: string[] = [];
  if (!input.auto) parts.push("explicitly requested");
  if (input.unverified) parts.push("not present in the provider's discovered catalogue");
  if (input.isPreferred) parts.push("operator-preferred model for this provider");
  parts.push(
    input.incrementalStreaming === true
      ? "reported incremental streaming"
      : input.incrementalStreaming === false
        ? "single-response provider (delivered as one chunk)"
        : "streaming capability not reported"
  );
  return `${input.provider}/${input.model}: ${parts.join("; ")}`;
}

function noCandidateMessage(requested: string, excluded: RouteExclusion[]): string {
  const head =
    requested && requested.toLowerCase() !== "auto"
      ? `No configured provider can serve the requested model '${requested}'.`
      : "No provider/model is currently eligible for automatic routing.";
  if (excluded.length === 0) {
    return `${head} No providers are configured. Set a provider endpoint (for example FREELLMAPI_BASE_URL or OLLAMA_BASE_URL) and retry.`;
  }
  const detail = excluded
    .slice(0, 6)
    .map((entry) => `${entry.provider}${entry.model ? `/${entry.model}` : ""}: ${entry.reason}`)
    .join(" | ");
  return `${head} Skipped: ${detail}`;
}

