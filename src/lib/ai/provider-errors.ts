import { ProviderHealthStatus } from "./types";

/**
 * Normalized provider failure model.
 *
 * Every adapter (`ollama`, `openai-compatible`, `freellmapi`, ...) turns its
 * wire-level failures into a `ProviderError` instead of leaking raw `fetch`
 * errors, HTTP bodies, or upstream text. Two rules apply here:
 *
 *  1. A provider failure is *never* converted into a different provider. This
 *     module only classifies and sanitizes; it does not select or fall back.
 *  2. A message produced here must never contain a credential. `redactSecrets`
 *     is applied to anything derived from upstream text, and the caller may
 *     pass the configured key so an echoing upstream cannot leak it.
 */

/**
 * Codes a provider failure can carry. `ProviderHealthStatus` is the subset a
 * health check can report (`available` means "no error").
 */
export type ProviderErrorCode =
  | Exclude<ProviderHealthStatus, "available">
  | "aborted"
  | "protocol"
  | "invalid_request";

/** Map an HTTP status code to the provider failure it represents. */
export function httpStatusToProviderCode(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 404 || status === 422) return "invalid_request";
  return "unavailable";
}

/** Map a failure code onto the status a health check reports. */
export function healthStatusForCode(code: ProviderErrorCode): ProviderHealthStatus {
  switch (code) {
    case "unauthorized":
      return "unauthorized";
    case "rate_limited":
      return "rate_limited";
    case "timeout":
      return "timeout";
    case "misconfigured":
    case "invalid_request":
      return "misconfigured";
    case "unavailable":
    case "aborted":
    case "protocol":
    default:
      return "unavailable";
  }
}

/** Map a health status back onto a failure code (used when a probe fails). */
export function healthStatusToErrorCode(status?: ProviderHealthStatus): ProviderErrorCode {
  switch (status) {
    case "unauthorized":
      return "unauthorized";
    case "rate_limited":
      return "rate_limited";
    case "timeout":
      return "timeout";
    case "misconfigured":
      return "misconfigured";
    case "available":
    case "unavailable":
    default:
      return "unavailable";
  }
}


const BEARER_VALUE = /\bbearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const SK_VALUE = /\bsk-[A-Za-z0-9._-]{6,}/g;
const KEY_ASSIGNMENT =
  /\b(api[-_]?key|apikey|access[-_]?token|auth[-_]?token|token|secret|password|authorization)\b\s*[:=]\s*["']?[^\s"',;{}]{4,}/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove anything that looks like a credential from a string.
 *
 * `extraSecrets` are exact values (for example the configured API key) that are
 * removed verbatim, so a provider that echoes the request back cannot leak it.
 */
export function redactSecrets(text: string, extraSecrets: Array<string | undefined> = []): string {
  let output = text;
  for (const secret of extraSecrets) {
    const trimmed = secret?.trim();
    if (trimmed && trimmed.length >= 4) {
      output = output.replace(new RegExp(escapeRegExp(trimmed), "g"), "***");
    }
  }
  return output
    .replace(BEARER_VALUE, "Bearer ***")
    .replace(SK_VALUE, "sk-***")
    .replace(KEY_ASSIGNMENT, "$1=***");
}

export interface ProviderErrorOptions {
  /** Upstream HTTP status, when a response was actually received. */
  status?: number;
  /** Raw cause. Kept for server-side context only; never sent to a client. */
  cause?: unknown;
}

/**
 * A classified provider failure.
 *
 * `message` is intended for the operator/UI and is already sanitized: use it in
 * logs, in SSE `error` events, and in provider health messages. It must never be
 * appended to a stack trace that is returned to a browser.
 */
export class ProviderError extends Error {
  public readonly providerId: string;
  public readonly code: ProviderErrorCode;
  public readonly status?: number;
  public readonly healthStatus: ProviderHealthStatus;
  public readonly retryable: boolean;

  constructor(
    providerId: string,
    code: ProviderErrorCode,
    message: string,
    options: ProviderErrorOptions = {}
  ) {
    super(message);
    this.name = "ProviderError";
    this.providerId = providerId;
    this.code = code;
    this.status = options.status;
    this.healthStatus = healthStatusForCode(code);
    this.retryable = code === "rate_limited" || code === "timeout" || code === "unavailable";
    if (options.cause !== undefined) {
      // Non-enumerable so serializers cannot emit the raw cause.
      Object.defineProperty(this, "cause", { value: options.cause, enumerable: false });
    }
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function looksLikeNetworkFailure(message: string): boolean {
  return (
    message.includes("fetch failed") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("EHOSTUNREACH") ||
    message.includes("ENETUNREACH") ||
    message.includes("ENOTFOUND") ||
    message.includes("EAI_AGAIN") ||
    message.includes("socket hang up")
  );
}

export interface NormalizeProviderErrorOptions {
  /** The configured credential, removed from any text that came from upstream. */
  secret?: string;
  /** True when the caller's own timeout fired. */
  timedOut?: boolean;
  /** True when the caller's AbortSignal was aborted by the user/route. */
  abortedByRequest?: boolean;
  /** Human context, e.g. "GET /v1/models". */
  operation?: string;
}

/**
 * Turn any thrown value into a classified, sanitized `ProviderError`.
 *
 * Already-classified errors pass through (with their message re-redacted).
 */
export function normalizeProviderError(
  providerId: string,
  error: unknown,
  options: NormalizeProviderErrorOptions = {}
): ProviderError {
  const operation = options.operation ? ` (${options.operation})` : "";

  if (error instanceof ProviderError) {
    const safe = redactSecrets(error.message, [options.secret]);
    if (safe === error.message) return error;
    return new ProviderError(providerId, error.code, safe, { status: error.status, cause: error });
  }

  const raw = error instanceof Error ? error.message : String(error ?? "");
  const safeRaw = redactSecrets(raw, [options.secret]).slice(0, 300);

  if (options.timedOut) {
    // Name the phase that actually stalled: reaching the provider at all is a
    // different failure from a generation that stopped mid-stream.
    const stalled = options.operation?.includes("chat/completions")
      ? "did not begin streaming within the first-byte budget"
      : "did not respond in time";
    return new ProviderError(
      providerId,
      "timeout",
      `${providerId} ${stalled}${operation}. The provider may be busy or unreachable.`,
      { cause: error }
    );
  }

  if (options.abortedByRequest) {
    return new ProviderError(
      providerId,
      "aborted",
      "The request was cancelled before the provider finished.",
      { cause: error }
    );
  }

  if (isAbortError(error)) {
    return new ProviderError(
      providerId,
      "timeout",
      `${providerId} did not respond in time${operation}.`,
      { cause: error }
    );
  }

  if (looksLikeNetworkFailure(raw)) {
    return new ProviderError(
      providerId,
      "unavailable",
      `${providerId} is not reachable${operation}: ${safeRaw || "network error"}.`,
      { cause: error }
    );
  }

  return new ProviderError(
    providerId,
    "unavailable",
    `${providerId} request failed${operation}: ${safeRaw || "unknown error"}.`,
    { cause: error }
  );
}

