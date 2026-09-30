/**
 * NEXA AI Gateway — AI Horde provider (native).
 *
 * AI Horde exposes an OpenAI-compatible proxy, so NEXA talks to it as a
 * first-class provider instead of relying on FreeLLMAPI's internal routing. The
 * behaviour of that proxy is reflected honestly here:
 *
 *  - A generation is queued and answered as **one blocking body**, so
 *    `supportsStreaming` is `false` for AI Horde models. NEXA still emits the
 *    text as a single `token` chunk followed by `done`, so every streaming
 *    client works — but nothing pretends the tokens arrived incrementally.
 *  - The anonymous key (`0000000000`) is always usable; a registered key is
 *    forwarded verbatim for higher queue priority. `requiresApiKey` is therefore
 *    false, and a missing key is never treated as an error.
 *  - `max_tokens` is floored at 16, because the proxy rejects smaller values.
 *
 * Credentials live in the server environment (`AI_HORDE_API_KEY`) and are sent
 * only in the Authorization header — never in a URL, never logged.
 */
import { GatewayError, httpStatusToCategory, type GatewayErrorCategory } from "../errors";
import type {
  AIProvider,
  AIProviderListOptions,
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  GatewayProviderId,
  ModelInfo,
  ProviderHealth,
} from "../types";
import { estimateUsage, modelsFromIds, newCompletionId, placeholderRouting } from "./shared";

/** The proxy rejects values below this floor. */
export const AI_HORDE_MIN_MAX_TOKENS = 16;
export const AI_HORDE_DEFAULT_MAX_TOKENS = 512;

interface ChatCompletionPayload {
  id?: unknown;
  choices?: Array<{
    message?: { content?: unknown; reasoning_content?: unknown };
    finish_reason?: unknown;
  }>;
}

export interface AIHordeProviderOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  anonymousKey: string;
  /** Model NEXA prefers when routing `auto` for this provider. */
  preferredModel?: string;
}

export class AIHordeProvider implements AIProvider {
  public readonly id: GatewayProviderId = "aihorde";
  public readonly name = "AI Horde";
  public readonly requiresApiKey = false;

  constructor(private readonly options: AIHordeProviderOptions) {}

  public get baseUrl(): string {
    return this.options.baseUrl;
  }

  public configurationIssue(): string | null {
    if (!this.baseUrl) return "AI_HORDE_BASE_URL is not set on the server.";
    if (!/^https?:\/\//i.test(this.baseUrl)) {
      return "AI_HORDE_BASE_URL must be a plain http(s) URL.";
    }
    return null;
  }

  public isConfigured(): boolean {
    return this.configurationIssue() === null;
  }

  public get preferredModel(): string | undefined {
    return this.options.preferredModel;
  }

  /** Bearer value: the registered key when present, else the anonymous key. */
  private resolveBearer(): string {
    const key = this.options.apiKey?.trim();
    if (!key || key === this.options.anonymousKey) return this.options.anonymousKey;
    return key;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${this.resolveBearer()}`,
    };
  }

  public async listModels(options: AIProviderListOptions = {}): Promise<ModelInfo[]> {
    const issue = this.configurationIssue();
    if (issue) throw new GatewayError("ProviderUnavailable", issue, {
      category: "permanent_configuration_failure",
      provider: this.id,
    });
    if (options.cacheOnly) return [];
    const payload = await this.requestJson("GET", "/models", undefined, options.signal);
    const ids = extractModelIds(payload);
    return modelsFromIds(this.id, ids, {
      requiresApiKey: false,
      // The AI Horde proxy answers a queued generation in one body.
      supportsStreaming: false,
      metadata: {
        streaming: "single-chunk",
        note: "AI Horde answers a queued generation in one response; NEXA re-frames it as a single chunk.",
      },
    });
  }

  public async health(options: AIProviderListOptions = {}): Promise<ProviderHealth> {
    const issue = this.configurationIssue();
    if (issue) {
      return {
        provider: this.id,
        status: "unavailable",
        ok: false,
        message: issue,
        latencyMs: 0,
        checkedAt: new Date().toISOString(),
        errorCategory: "permanent_configuration_failure",
      };
    }
    if (options.cacheOnly) {
      return {
        provider: this.id,
        status: "configured",
        ok: false,
        message: "AI Horde is configured; reachability has not been probed in this request.",
        latencyMs: 0,
        checkedAt: new Date().toISOString(),
      };
    }
    const started = Date.now();
    try {
      const payload = await this.requestJson("GET", "/models", undefined, options.signal);
      const ids = extractModelIds(payload);
      return {
        provider: this.id,
        status: "healthy",
        ok: true,
        message: `AI Horde answered GET /models with ${ids.length} model(s).`,
        latencyMs: Date.now() - started,
        models: ids,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      const gatewayError = asGatewayError(error, this.id);
      return {
        provider: this.id,
        status:
          gatewayError.category === "authentication_failure"
            ? "authentication_error"
            : gatewayError.category === "timeout"
              ? "timeout"
              : gatewayError.category === "rate_limit"
                ? "rate_limited"
                : "unavailable",
        ok: false,
        message: gatewayError.message,
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
        errorCategory: gatewayError.category,
      };
    }
  }

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = (request.model ?? "").trim();
    if (!model) {
      throw new GatewayError("ModelNotFound", "No AI Horde model was selected.", {
        category: "invalid_model",
        provider: this.id,
      });
    }
    const started = Date.now();
    const payload = await this.requestJson(
      "POST",
      "/chat/completions",
      {
        model,
        messages: withSystemPrompt(request.messages, request.systemPrompt),
        max_tokens: Math.max(
          AI_HORDE_MIN_MAX_TOKENS,
          request.maxTokens ?? AI_HORDE_DEFAULT_MAX_TOKENS
        ),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.topP !== undefined ? { top_p: request.topP } : {}),
        ...(request.stop && request.stop.length > 0 ? { stop: request.stop } : {}),
      },
      request.signal
    );

    const completion = payload as ChatCompletionPayload;
    const content = extractContent(completion);
    const reasoning = extractReasoning(completion);
    return {
      id: typeof completion?.id === "string" ? completion.id : newCompletionId(),
      model,
      provider: this.id,
      content,
      ...(reasoning ? { reasoning } : {}),
      finishReason: extractFinishReason(completion),
      usage: estimateUsage(request.messages, content),
      latencyMs: Date.now() - started,
      createdAt: Math.floor(Date.now() / 1000),
      routing: placeholderRouting(this.id, model, request.model),
    };
  }

  /**
   * AI Horde cannot stream token-by-token, so the blocking call is awaited and
   * re-framed: one `token` chunk, then `done`. A failure surfaces as a single
   * `error` chunk carrying the classified `GatewayError`.
   */
  public async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
    try {
      const response = await this.chat(request);
      if (response.content) yield { type: "token", content: response.content };
      if (response.reasoning) yield { type: "reasoning", content: response.reasoning };
      yield { type: "done", data: response };
    } catch (error) {
      const gatewayError = asGatewayError(error, this.id, request.signal?.aborted === true);
      yield { type: "error", content: gatewayError.message, data: gatewayError };
    }
  }

  /** One bounded HTTP call, with the failure already classified. */
  private async requestJson(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    externalSignal?: AbortSignal
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);
    const onAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await fetch(url, {
        method,
        headers: this.headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const category = httpStatusToCategory(response.status);
        throw new GatewayError(codeForCategory(category), describeStatus(response.status, text), {
          category,
          provider: this.id,
          upstreamStatus: response.status,
        });
      }
      return (await response.json().catch(() => null)) as unknown;
    } catch (error) {
      throw asGatewayError(error, this.id, externalSignal?.aborted === true, timedOut, {
        apiKey: this.options.apiKey,
      });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  }
}

function codeForCategory(category: GatewayErrorCategory) {
  switch (category) {
    case "authentication_failure":
      return "ProviderAuthenticationError" as const;
    case "rate_limit":
      return "RateLimited" as const;
    case "invalid_model":
      return "ModelNotFound" as const;
    case "timeout":
      return "ProviderTimeout" as const;
    default:
      return "ProviderUnavailable" as const;
  }
}

function withSystemPrompt(messages: ChatMessage[], systemPrompt?: string): ChatMessage[] {
  return [
    ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
    ...messages.map((message) => ({ role: message.role, content: message.content })),
  ];
}

/** Model ids from the OpenAI-shaped `/models` payload, deduplicated. */
export function extractModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) ids.push(id.trim());
  }
  return Array.from(new Set(ids));
}

export function extractContent(payload: ChatCompletionPayload | null | undefined): string {
  const content = payload?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

export function extractReasoning(payload: ChatCompletionPayload | null | undefined): string {
  const reasoning = payload?.choices?.[0]?.message?.reasoning_content;
  return typeof reasoning === "string" ? reasoning : "";
}

export function extractFinishReason(
  payload: ChatCompletionPayload | null | undefined
): ChatResponse["finishReason"] {
  const reason = payload?.choices?.[0]?.finish_reason;
  return reason === "length" ? "length" : "stop";
}

/** Redact a credential from upstream text (defence in depth). */
function sanitizeDetail(detail: string, secret?: string): string {
  const trimmed = detail.trim().slice(0, 200);
  const key = secret?.trim();
  if (!key || key.length < 6) return trimmed;
  return trimmed.split(key).join("***");
}

/** Sanitized, credential-free description of a failed upstream response. */
function describeStatus(status: number, text: string, secret?: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(text) as { detail?: unknown; error?: { message?: unknown } };
    if (typeof parsed?.detail === "string") detail = parsed.detail;
    else if (typeof parsed?.error?.message === "string") detail = parsed.error.message;
  } catch {
    // Non-JSON body: the status code alone is reported.
  }
  return detail
    ? `AI Horde answered HTTP ${status}: ${sanitizeDetail(detail, secret)}`
    : `AI Horde answered HTTP ${status}.`;
}

/** Normalize any thrown value into a classified gateway error. */
export function asGatewayError(
  error: unknown,
  provider: GatewayProviderId,
  userAborted = false,
  timedOut = false,
  options: { apiKey?: string } = {}
): GatewayError {
  if (error instanceof GatewayError) return error;

  const message = error instanceof Error ? error.message : String(error ?? "");
  const abortLike =
    error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

  if (userAborted) {
    return new GatewayError(
      "GatewayError",
      "The request was cancelled before AI Horde answered.",
      { category: "cancelled", provider, cause: error }
    );
  }
  if (timedOut || abortLike) {
    return new GatewayError(
      "ProviderTimeout",
      "AI Horde did not answer in time. Queued generations can take a while; retry, or raise AI_HORDE_TIMEOUT_MS.",
      { category: "timeout", provider, cause: error }
    );
  }
  const networky =
    /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|socket hang up/i.test(message);
  const category: GatewayErrorCategory = networky ? "temporary_upstream_failure" : "unknown";
  return new GatewayError(
    "ProviderUnavailable",
    `AI Horde request failed: ${sanitizeDetail(message, options.apiKey) || "unknown error"}.`,
    { category, provider, cause: error }
  );
}
