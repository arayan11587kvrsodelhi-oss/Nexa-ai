import { ProviderType } from "@/types";
import { SecurityGuard } from "@/lib/security/sanitize";
import { DiscoveredModel } from "../registry";
import {
  GenerateOptions,
  ModelProvider,
  ProviderConnectionResult,
  ProviderHealthStatus,
  StreamEvent,
} from "../types";
import {
  ProviderError,
  httpStatusToProviderCode,
  normalizeProviderError,
  redactSecrets,
} from "../provider-errors";

/**
 * FreeLLMAPI — a first-class NEXA provider.
 *
 * It is *an OpenAI-compatible backend*, not a new architecture: it implements
 * the existing `ModelProvider` contract (health probe, model discovery,
 * streaming generation) and is instantiated by the shared
 * `providers/factory.ts`, exactly like Ollama and the generic OpenAI-compatible
 * adapter.
 *
 * Wire protocol (only these two endpoints are ever called):
 *
 *   GET  {FREELLMAPI_BASE_URL}/v1/models
 *   POST {FREELLMAPI_BASE_URL}/v1/chat/completions
 *
 * Configuration
 * -------------
 *   FREELLMAPI_BASE_URL  required; server-side only. No production host is
 *                        hard-coded. Nothing is called while it is unset.
 *   FREELLMAPI_API_KEY   optional (a local installation may not require one).
 *                        Sent as `Authorization: Bearer <key>` only when set.
 *                        It is never logged, never placed in a URL, and never
 *                        returned by an API route.
 */

/** Health probe + model discovery budget. */
const DISCOVERY_TIMEOUT_MS = 4_000;
/**
 * Time allowed for the chat endpoint to return response *headers*.
 *
 * This is a first-byte budget, not a "response time" budget: for a streaming
 * request the headers arrive as soon as the provider starts emitting, so this
 * only has to cover TCP/TLS setup plus FreeLLMAPI's own routing to an upstream
 * model. Measured against a live FreeLLMAPI installation, healthy first-byte
 * latency is ~0.5-5 s, but `model: "auto"` routing occasionally takes longer
 * when the provider pool is saturated, which previously surfaced as a bogus
 * "did not respond in time" even though the provider was healthy and busy.
 * The mid-stream ceiling (IDLE_TIMEOUT_MS) is what actually bounds a
 * generation, and it is unchanged.
 */
const CONNECT_TIMEOUT_MS = 60_000;
/** Maximum silence between two streamed chunks before the stream is abandoned. */
const IDLE_TIMEOUT_MS = 60_000;
/** Upper bound for a single SSE line, so a malformed peer cannot exhaust memory. */
const MAX_SSE_LINE_CHARS = 1_000_000;
/** Upper bound for one streamed response body. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface FreeLLMAPICatalog {
  /** True when FREELLMAPI_BASE_URL was usable and a request was attempted. */
  configured: boolean;
  models: DiscoveredModel[];
  health: ProviderConnectionResult & { status: ProviderHealthStatus };
}

/**
 * Normalize a configured base URL into the origin the `/v1/...` paths hang off.
 * Accepts `http://host:port`, `http://host:port/`, and `http://host:port/v1`
 * (a trailing `/v1` is not duplicated).
 */
export function normalizeFreeLLMAPIBaseUrl(raw: string | undefined): string {
  let url = (raw ?? "").trim();
  if (!url) return "";
  url = url.replace(/\/+$/, "");
  return /\/v1$/i.test(url) ? url.slice(0, -3).replace(/\/+$/, "") : url;
}

function firstPositiveNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.trunc(value);
    }
  }
  return null;
}

/**
 * Normalize a `/v1/models` payload into NEXA's discovery shape.
 *
 * Anything the provider does not report stays `null`. Capabilities such as tool
 * calling or vision are *never* inferred from a model name.
 */
export function parseFreeLLMAPIModelList(
  payload: unknown,
  providerId: ProviderType = "freellmapi"
): DiscoveredModel[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  const discoveredAt = new Date().toISOString();

  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as {
      id?: unknown;
      name?: unknown;
      owned_by?: unknown;
      context_length?: unknown;
      context_window?: unknown;
      max_context_tokens?: unknown;
    };
    if (typeof raw.id !== "string") continue;
    const id = raw.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const reportedName = typeof raw.name === "string" ? raw.name.trim() : "";
    models.push({
      id,
      provider: providerId,
      name: reportedName || id,
      contextWindow: firstPositiveNumber(
        raw.context_length,
        raw.context_window,
        raw.max_context_tokens
      ),
      // /v1/models does not advertise these, so NEXA does not claim them.
      supportsStreaming: null,
      supportsTools: null,
      supportsVision: null,
      ownedBy:
        typeof raw.owned_by === "string" && raw.owned_by.trim() ? raw.owned_by.trim() : undefined,
      discoveredAt,
    });
  }

  return models;
}

export class FreeLLMAPIProvider implements ModelProvider {
  public readonly id = "freellmapi";
  public readonly name = "FreeLLMAPI";
  public readonly type = "freellmapi" as const;
  public readonly baseUrl: string;
  /** Private: only ever used to build the Authorization header. */
  private readonly credential?: string;

  constructor(baseUrl?: string, apiKey?: string) {
    const explicitBaseUrl = baseUrl?.trim();
    this.baseUrl = normalizeFreeLLMAPIBaseUrl(explicitBaseUrl || process.env.FREELLMAPI_BASE_URL);
    const explicitKey = apiKey?.trim();
    const envKey = process.env.FREELLMAPI_API_KEY?.trim();
    this.credential = (explicitKey || envKey) ?? undefined;
  }

  /** Endpoint for model discovery. Per the task contract, `GET {BASE_URL}/v1/models`. */
  public get modelsEndpoint(): string {
    return `${this.baseUrl}/v1/models`;
  }

  /** Endpoint for chat. `POST {BASE_URL}/v1/chat/completions`. */
  public get chatEndpoint(): string {
    return `${this.baseUrl}/v1/chat/completions`;
  }

  /** Whether an API key is configured. Never reveals the key itself. */
  public hasCredential(): boolean {
    return Boolean(this.credential);
  }

  /** Returns an operator-facing explanation when the provider is unusable. */
  public getConfigurationIssue(): string | null {
    if (!this.baseUrl) {
      return "FREELLMAPI_BASE_URL is not set on the server.";
    }
    // SSRF guard: only plain http(s), and never a cloud metadata endpoint.
    if (!SecurityGuard.isSafeUrl(this.baseUrl)) {
      return "FREELLMAPI_BASE_URL must be a plain http(s) URL that does not target a cloud metadata endpoint.";
    }
    return null;
  }

  public isConfigured(): boolean {
    return this.getConfigurationIssue() === null;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
    };
    // Authorization is added only when a key is configured: a local
    // FreeLLMAPI installation may legitimately require none.
    if (this.credential) {
      headers.Authorization = `Bearer ${this.credential}`;
    }
    return headers;
  }

  /** Turn an upstream HTTP failure into a sanitized, classified message. */
  private httpFailure(operation: string, status: number, upstreamText: string): ProviderError {
    const code = httpStatusToProviderCode(status);
    const detail = redactSecrets(upstreamText, [this.credential]).trim().slice(0, 200);
    const base = (() => {
      switch (code) {
        case "unauthorized":
          return `FreeLLMAPI rejected the configured credentials (HTTP ${status}) on ${operation}. Check FREELLMAPI_API_KEY.`;
        case "rate_limited":
          return "FreeLLMAPI is rate-limiting requests (HTTP 429). The provider pool may be busy; retry shortly.";
        case "timeout":
          return `FreeLLMAPI timed out on ${operation} (HTTP ${status}).`;
        case "invalid_request":
          return `FreeLLMAPI answered HTTP ${status} on ${operation}. Check FREELLMAPI_BASE_URL and the selected model.`;
        default:
          return `FreeLLMAPI answered HTTP ${status} on ${operation}.`;
      }
    })();
    return new ProviderError(this.id, code, detail ? `${base} Provider said: ${detail}` : base, {
      status,
    });
  }

  /**
   * Single primitive behind `testConnection()`, `listModels()` and
   * `/api/models` discovery: one `GET /v1/models` call, bounded by a short
   * timeout, classified, and never throwing.
   */
  public async discoverCatalog(options: { signal?: AbortSignal } = {}): Promise<FreeLLMAPICatalog> {
    const issue = this.getConfigurationIssue();
    if (issue) {
      return {
        configured: false,
        models: [],
        health: {
          ok: false,
          status: "misconfigured",
          message: `FreeLLMAPI is not usable: ${issue}`,
          latencyMs: 0,
        },
      };
    }

    const start = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, DISCOVERY_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const res = await fetch(this.modelsEndpoint, {
        method: "GET",
        headers: this.buildHeaders(),
        signal: controller.signal,
        cache: "no-store",
      });
      const latencyMs = Date.now() - start;

      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        const failure = this.httpFailure("GET /v1/models", res.status, text);
        return {
          configured: true,
          models: [],
          health: {
            ok: false,
            status: failure.healthStatus,
            message: failure.message,
            latencyMs,
          },
        };
      }

      const payload: unknown = await res.json().catch(() => null);
      const models = parseFreeLLMAPIModelList(payload);
      return {
        configured: true,
        models,
        health: {
          ok: true,
          status: "available",
          message: `Connected to FreeLLMAPI at ${this.baseUrl} (${models.length} models reported by the provider)`,
          models: models.map((m) => m.id),
          latencyMs,
        },
      };
    } catch (err: unknown) {
      const normalized = normalizeProviderError(this.id, err, {
        secret: this.credential,
        timedOut,
        abortedByRequest: options.signal?.aborted === true && !timedOut,
        operation: "GET /v1/models",
      });
      return {
        configured: true,
        models: [],
        health: {
          ok: false,
          status: normalized.healthStatus,
          message:
            normalized.healthStatus === "timeout"
              ? `FreeLLMAPI did not answer ${this.modelsEndpoint} within ${DISCOVERY_TIMEOUT_MS} ms.`
              : normalized.message,
          latencyMs: Date.now() - start,
        },
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Lightweight health check. Structured result; never throws. */
  public async testConnection(): Promise<ProviderConnectionResult> {
    const { health } = await this.discoverCatalog();
    return health;
  }

  /** Model ids reported by the provider. `[]` when discovery fails. */
  public async listModels(): Promise<string[]> {
    const { models } = await this.discoverCatalog();
    return models.map((m) => m.id);
  }

  /**
   * Stream a chat completion.
   *
   * Token events are emitted as chunks arrive — nothing is buffered before the
   * first token is shown. The stream terminates on `data: [DONE]` and the
   * underlying reader is always released. Failures are thrown as normalized
   * `ProviderError`s, never converted into a different provider's output.
   */
  public async generateStream(
    options: GenerateOptions,
    emitEvent: (event: StreamEvent) => void
  ): Promise<{ fullText: string; reasoningText?: string; latencyMs: number }> {
    const start = Date.now();
    const issue = this.getConfigurationIssue();
    if (issue) {
      throw new ProviderError(this.id, "misconfigured", `FreeLLMAPI is not usable: ${issue}`);
    }

    const model = options.model?.trim() ?? "";
    if (!model) {
      throw new ProviderError(
        this.id,
        "invalid_request",
        "No FreeLLMAPI model was selected. Discover models via GET /api/models, or set FREELLMAPI_MODEL or a model in the model configuration."
      );
    }

    if (options.signal?.aborted) {
      throw new ProviderError(this.id, "aborted", "The request was cancelled before it was sent.");
    }

    // Only fields the existing NEXA abstraction actually carries are forwarded.
    const payload = {
      model,
      messages: [
        ...(options.systemPrompt ? [{ role: "system", content: options.systemPrompt }] : []),
        ...options.messages,
      ],
      stream: true,
      temperature: options.temperature ?? 0.7,
      top_p: options.topP ?? 0.9,
      max_tokens: options.maxTokens ?? 4096,
    };

    const controller = new AbortController();
    let timedOut = false;
    const connectTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CONNECT_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const bumpIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, IDLE_TIMEOUT_MS);
    };

    let fullText = "";
    let reasoningText = "";

    try {
      const res = await fetch(this.chatEndpoint, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(connectTimer);

      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        throw this.httpFailure("POST /v1/chat/completions", res.status, errText);
      }
      if (!res.body) {
        throw new ProviderError(this.id, "protocol", "FreeLLMAPI returned an empty response body.");
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!/text\/event-stream/i.test(contentType)) {
        // The endpoint answered with one JSON object instead of an SSE stream.
        // Nothing is invented: the real text is emitted as a single token.
        const single = extractCompletionText(safeJsonParse(await res.text()));
        if (single.reasoning) {
          reasoningText += single.reasoning;
          emitEvent({ type: "reasoning", content: single.reasoning });
        }
        if (single.content) {
          fullText += single.content;
          emitEvent({ type: "token", content: single.content });
        }
        if (!fullText && !reasoningText) {
          throw new ProviderError(
            this.id,
            "protocol",
            "FreeLLMAPI returned a non-streaming response that contained no text."
          );
        }
        emitEvent({ type: "done" });
        return { fullText, reasoningText: reasoningText || undefined, latencyMs: Date.now() - start };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      const race = createAbortRace(controller);
      let terminated = false;
      let sawFinishReason = false;
      let buffer = "";
      let bytes = 0;

      try {
        bumpIdleTimer();
        while (!terminated) {
          const { done, value } = await Promise.race([reader.read(), race.promise]);
          if (done) break;

          bytes += value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            throw new ProviderError(
              this.id,
              "protocol",
              `FreeLLMAPI sent more than ${MAX_RESPONSE_BYTES} bytes and the stream was terminated.`
            );
          }
          bumpIdleTimer();

          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > MAX_SSE_LINE_CHARS) {
            throw new ProviderError(
              this.id,
              "protocol",
              "FreeLLMAPI sent an SSE frame larger than the supported safety limit."
            );
          }

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            // Ignore blank lines, SSE comments and event:/id: fields.
            if (!trimmed || !trimmed.startsWith("data:")) continue;

            const dataStr = trimmed.slice(5).trim();
            if (dataStr === "[DONE]") {
              terminated = true;
              break;
            }
            if (!dataStr) continue;

            const frame = safeJsonParse(dataStr);
            if (frame === undefined) {
              // Malformed frame: skipped. Valid frames keep flowing and nothing
              // is emitted twice.
              continue;
            }

            const streamError = extractStreamError(frame);
            if (streamError) {
              throw new ProviderError(
                this.id,
                "unavailable",
                `FreeLLMAPI reported an error mid-stream: ${redactSecrets(streamError, [this.credential]).slice(0, 200)}`
              );
            }

            const delta = extractCompletionText(frame);
            if (delta.finished) sawFinishReason = true;
            if (delta.reasoning) {
              reasoningText += delta.reasoning;
              emitEvent({ type: "reasoning", content: delta.reasoning });
            }
            if (delta.content) {
              fullText += delta.content;
              emitEvent({ type: "token", content: delta.content });
            }
          }
        }
      } finally {
        race.dispose();
        // Stops reading (and releases the socket) even on abort/timeout/error.
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }

      if (!terminated && !sawFinishReason && !fullText && !reasoningText) {
        throw new ProviderError(
          this.id,
          "protocol",
          "FreeLLMAPI closed the stream before sending content or a [DONE] marker."
        );
      }
    } catch (err: unknown) {
      throw normalizeProviderError(this.id, err, {
        secret: this.credential,
        timedOut,
        abortedByRequest: options.signal?.aborted === true && !timedOut,
        operation: "POST /v1/chat/completions",
      });
    } finally {
      clearTimeout(connectTimer);
      if (idleTimer) clearTimeout(idleTimer);
      options.signal?.removeEventListener("abort", onAbort);
    }

    emitEvent({ type: "done" });
    return { fullText, reasoningText: reasoningText || undefined, latencyMs: Date.now() - start };
  }
}




interface CompletionText {
  content: string;
  reasoning: string;
  /** True when the frame carried a `finish_reason`. */
  finished: boolean;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Read the text out of one OpenAI-compatible frame (or out of a single
 * non-streaming completion object).
 *
 * `delta` is preferred over `message` so a frame that carries both cannot emit
 * the same text twice.
 */
export function extractCompletionText(payload: unknown): CompletionText {
  const result: CompletionText = { content: "", reasoning: "", finished: false };
  if (!payload || typeof payload !== "object") return result;

  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return result;

  const choice = choices[0];
  if (!choice || typeof choice !== "object") return result;

  const container = choice as {
    delta?: unknown;
    message?: unknown;
    text?: unknown;
    finish_reason?: unknown;
  };
  if (typeof container.finish_reason === "string" && container.finish_reason) {
    result.finished = true;
  }

  const delta = (container.delta ?? {}) as {
    content?: unknown;
    reasoning_content?: unknown;
    reasoning?: unknown;
  };
  const message = (container.message ?? {}) as {
    content?: unknown;
    reasoning_content?: unknown;
  };

  result.content =
    stringValue(delta.content) || stringValue(message.content) || stringValue(container.text);

  result.reasoning =
    stringValue(delta.reasoning_content) ||
    stringValue(delta.reasoning) ||
    stringValue(message.reasoning_content);

  return result;
}

/** Extract an error object streamed inside an otherwise HTTP-200 SSE frame. */
export function extractStreamError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const error = (payload as { error?: unknown }).error;
  if (!error) return undefined;
  if (typeof error === "string") return error.trim() || undefined;
  if (typeof error === "object") {
    const detail = error as { message?: unknown; type?: unknown; code?: unknown };
    for (const candidate of [detail.message, detail.type, detail.code]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    return "unspecified provider error";
  }
  return undefined;
}

/** JSON.parse that reports malformed input as `undefined` instead of throwing. */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface AbortRace {
  /** Rejects as soon as the controller aborts. */
  promise: Promise<never>;
  dispose: () => void;
}

/**
 * Race a pending read against the request's abort signal, so cancellation and
 * idle timeouts take effect immediately even when the transport keeps the
 * socket open.
 */
function createAbortRace(controller: AbortController): AbortRace {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(new Error("provider request aborted"));
    if (controller.signal.aborted) {
      abort();
      return;
    }
    onAbort = abort;
    controller.signal.addEventListener("abort", abort, { once: true });
  });
  // The loser of a `Promise.race` must not surface as an unhandled rejection.
  promise.catch(() => undefined);
  return {
    promise,
    dispose: () => {
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    },
  };
}

