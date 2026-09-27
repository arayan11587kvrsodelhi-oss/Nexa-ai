import { Message, ModelDescriptor, ModelProfile, ProviderType } from "@/types";

export interface StreamEvent {
  type: "token" | "reasoning" | "action" | "tool_call" | "citation" | "done" | "error";
  content?: string;
  data?: unknown;
}

/**
 * Structured outcome of a provider reachability probe.
 *
 * `available` means the probe succeeded. Every other value is a classified
 * failure that the UI can explain without guessing (see
 * `src/lib/ai/provider-errors.ts` for the code <-> status mapping).
 */
export type ProviderHealthStatus =
  | "available"
  | "unavailable"
  | "timeout"
  | "unauthorized"
  | "rate_limited"
  | "misconfigured";

export interface ProviderConnectionResult {
  ok: boolean;
  message: string;
  models?: string[];
  latencyMs?: number;
  /**
   * Optional so existing adapters (Ollama, OpenAI-compatible, demo) keep their
   * contract unchanged. Adapters that classify failures populate it.
   */
  status?: ProviderHealthStatus;
}

export interface GenerateOptions {
  model: string;
  messages: Array<{
    role: "user" | "assistant" | "system" | "tool";
    content: string;
  }>;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  systemPrompt?: string;
  signal?: AbortSignal;
  onChunk?: (token: string) => void;
  onReasoning?: (token: string) => void;
  onAction?: (actionText: string) => void;
}

export interface ModelProvider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;
  testConnection(): Promise<ProviderConnectionResult>;
  listModels(): Promise<string[]>;
  generateStream(
    options: GenerateOptions,
    emitEvent: (event: StreamEvent) => void
  ): Promise<{ fullText: string; reasoningText?: string; latencyMs: number }>;
  embed?(text: string): Promise<number[]>;
}
