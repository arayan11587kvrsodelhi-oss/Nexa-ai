/**
 * NEXA AI Gateway — core contracts.
 *
 * This is the boundary every provider adapter implements. Nothing above this
 * interface knows how AI Horde, Ollama, or an OpenAI-compatible endpoint talks
 * on the wire; nothing below it knows about NEXA's conversations, users, or
 * database rows.
 *
 * The interface is intentionally the one promised in the migration brief:
 *
 *   interface AIProvider {
 *     id; name; listModels(); health(); chat(); streamChat();
 *   }
 *
 * with optional `options` arguments added so cancellation and timeouts can be
 * threaded through without changing the shape.
 */
import type { GatewayError, GatewayErrorCategory } from "./errors";

export type GatewayProviderId =
  | "aihorde"
  | "ollama"
  | "openai_compatible"
  | "vllm"
  /** FreeLLMAPI: the external gateway NEXA currently runs. Kept during migration. */
  | "freellmapi";

export const GATEWAY_PROVIDER_IDS: readonly GatewayProviderId[] = [
  "aihorde",
  "ollama",
  "openai_compatible",
  "vllm",
  "freellmapi",
];

/**
 * Provider/model health vocabulary.
 *
 * `discovered` and `configured` are *not* health claims — they describe what
 * NEXA knows before any probe ran. Only `healthy` means a probe succeeded.
 * A model is never marked healthy because it appeared in a list.
 */
export type GatewayHealthStatus =
  | "discovered"
  | "configured"
  | "healthy"
  | "unavailable"
  | "rate_limited"
  | "timeout"
  | "authentication_error"
  | "provider_error";

/** Statuses that mean "do not route here right now". */
export const UNHEALTHY_STATUSES: readonly GatewayHealthStatus[] = [
  "unavailable",
  "rate_limited",
  "timeout",
  "authentication_error",
  "provider_error",
];

export type ModelAvailability =
  | "available"
  | "unknown"
  | "unavailable"
  | "rate_limited"
  | "timeout"
  | "authentication_error"
  | "provider_error";

export interface ModelCapabilities {
  /** null = the provider did not report it. Never inferred from the model name. */
  streaming: boolean | null;
  /** null = not reported. */
  tools: boolean | null;
  /** null = not reported. */
  vision: boolean | null;
  /** null = not reported. */
  embeddings: boolean | null;
}

/** Normalized internal model representation. */
export interface ModelInfo {
  /** The id the provider itself uses. What must be sent back on a request. */
  id: string;
  displayName: string;
  provider: GatewayProviderId;
  capabilities: ModelCapabilities;
  /** Provider-reported context window in tokens, or null when not reported. */
  contextLength: number | null;
  /** Mirror of `capabilities.streaming`, kept top-level for clients. */
  streaming: boolean | null;
  availability: ModelAvailability;
  requiresApiKey: boolean;
  /** ISO timestamp of the last health observation for this model, or null. */
  lastHealthCheck: string | null;
  ownedBy?: string;
  discoveredAt: string;
  metadata: Record<string, unknown>;
}

export interface ProviderHealth {
  provider: GatewayProviderId;
  status: GatewayHealthStatus;
  ok: boolean;
  message: string;
  latencyMs: number;
  models?: string[];
  checkedAt: string;
  errorCategory?: GatewayErrorCategory;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

export interface ChatRequest {
  /** "auto", a raw model id, or a pinned reference: `provider/model` or `provider:model`. */
  model: string;
  messages: ChatMessage[];
  /** Whether the caller wants incremental delivery. */
  stream: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  systemPrompt?: string;
  signal?: AbortSignal;
  requestId?: string;
  /** Free-form server-side context. Never contains credentials. */
  metadata?: Record<string, unknown>;
}

export interface ChatUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** True when the counts were estimated because the provider reported none. */
  estimated: boolean;
}

export interface RoutingAttempt {
  provider: GatewayProviderId;
  model: string;
  outcome: "success" | "failed" | "skipped";
  errorCategory?: GatewayErrorCategory;
  latencyMs: number;
}

export interface RoutingMetadata {
  requestedModel: string;
  selectedProvider: GatewayProviderId;
  selectedModel: string;
  strategy: "explicit" | "auto";
  /** Human-readable, deterministic explanation of why this candidate won. */
  reason: string;
  /** Ordered candidate chain, best first. */
  candidates: Array<{ provider: GatewayProviderId; model: string; reason: string }>;
  attempts: RoutingAttempt[];
  fallbackUsed: boolean;
}

export interface ChatResponse {
  id: string;
  model: string;
  provider: GatewayProviderId;
  content: string;
  reasoning?: string;
  finishReason: "stop" | "length" | "error" | "cancelled";
  usage: ChatUsage | null;
  latencyMs: number;
  createdAt: number;
  routing: RoutingMetadata;
}

/**
 * Normalized stream event.
 *
 * Providers convert their own framing (SSE, NDJSON, one blocking body) into
 * exactly these shapes; consumers never see provider-specific JSON.
 */
export type ChatChunk =
  | { type: "token"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "action"; content: string }
  | { type: "error"; content: string; data?: GatewayError }
  | { type: "done"; data: ChatResponse };

export interface AIProviderListOptions {
  signal?: AbortSignal;
  /** Skip the network and answer from the last discovery, when known. */
  cacheOnly?: boolean;
}

export interface AIProvider {
  id: GatewayProviderId;
  name: string;
  /** True when this provider cannot work without a credential. */
  requiresApiKey: boolean;
  /** Endpoint that will be called. Never contains a credential. */
  baseUrl: string;
  /** Null when usable; otherwise an operator-facing explanation. */
  configurationIssue(): string | null;
  isConfigured(): boolean;
  listModels(options?: AIProviderListOptions): Promise<ModelInfo[]>;
  health(options?: AIProviderListOptions): Promise<ProviderHealth>;
  chat(request: ChatRequest): Promise<ChatResponse>;
  streamChat(request: ChatRequest): AsyncIterable<ChatChunk>;
}
