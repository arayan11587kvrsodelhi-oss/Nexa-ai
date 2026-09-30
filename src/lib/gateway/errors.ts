/**
 * NEXA AI Gateway — error taxonomy.
 *
 * Every failure a provider adapter can produce is normalized into exactly one
 * `GatewayErrorCode` (the public, OpenAI-compatible family) plus one
 * `GatewayErrorCategory` (the fine-grained reason the retry/fallback policy
 * actually needs).
 *
 * Two hard rules:
 *
 *  1. A `GatewayError` never contains a credential, an upstream stack trace, or
 *     a raw provider body. `sanitize` is applied to anything derived from
 *     upstream text, and the configured secret is passed in so an echoing
 *     upstream cannot leak it.
 *  2. Classification is explicit. Nothing is assumed transient, and nothing is
 *     assumed healthy — an unclassified failure is `GatewayError` with category
 *     `unknown`, which is *not* retried indefinitely.
 */

/** Public error family. Maps 1:1 onto an HTTP status + OpenAI error `type`. */
export type GatewayErrorCode =
  | "ProviderUnavailable"
  | "ProviderTimeout"
  | "ProviderAuthenticationError"
  | "ModelUnavailable"
  | "ModelNotFound"
  | "RateLimited"
  | "InvalidRequest"
  | "GatewayError";

/**
 * Why the failure happened. This is what the retry policy branches on:
 * timeout / rate limit / temporary upstream failure / invalid model /
 * authentication failure / permanent configuration failure.
 */
export type GatewayErrorCategory =
  | "timeout"
  | "rate_limit"
  | "temporary_upstream_failure"
  | "invalid_model"
  | "authentication_failure"
  | "permanent_configuration_failure"
  | "invalid_request"
  | "cancelled"
  | "unknown";

const STATUS: Record<GatewayErrorCode, number> = {
  ProviderUnavailable: 503,
  ProviderTimeout: 504,
  ProviderAuthenticationError: 502,
  ModelUnavailable: 503,
  ModelNotFound: 404,
  RateLimited: 429,
  InvalidRequest: 400,
  GatewayError: 500,
};

/** Short, stable, machine-readable `type` for the OpenAI error envelope. */
const OPENAI_TYPE: Record<GatewayErrorCode, string> = {
  ProviderUnavailable: "provider_unavailable",
  ProviderTimeout: "provider_timeout",
  ProviderAuthenticationError: "provider_authentication_error",
  ModelUnavailable: "model_unavailable",
  ModelNotFound: "model_not_found",
  RateLimited: "rate_limited",
  InvalidRequest: "invalid_request_error",
  GatewayError: "gateway_error",
};

const BEARER_VALUE = /\bbearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const SK_VALUE = /\b(?:sk|nexa_sk)[-_][A-Za-z0-9._-]{6,}/g;
const KEY_ASSIGNMENT =
  /\b(api[-_]?key|apikey|access[-_]?token|auth[-_]?token|token|secret|password|authorization)\b\s*[:=]\s*["']?[^\s"',;{}]{4,}/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove anything that looks like a credential from a string.
 *
 * `extraSecrets` are exact values (e.g. the configured API key) removed
 * verbatim, so an upstream that echoes the request back cannot leak it.
 */
export function sanitize(text: string, extraSecrets: Array<string | undefined> = []): string {
  let output = text;
  for (const secret of extraSecrets) {
    const trimmed = secret?.trim();
    if (trimmed && trimmed.length >= 6) {
      output = output.replace(new RegExp(escapeRegExp(trimmed), "g"), "***");
    }
  }
  return output
    .replace(BEARER_VALUE, "Bearer ***")
    .replace(SK_VALUE, "***")
    .replace(KEY_ASSIGNMENT, "$1=***");
}

export interface GatewayErrorOptions {
  category?: GatewayErrorCategory;
  /** HTTP status the *client* should receive. Defaults from the code. */
  status?: number;
  /** Upstream status, kept for server logs only. */
  upstreamStatus?: number;
  provider?: string;
  model?: string;
  cause?: unknown;
  /**
   * The request field the caller got wrong, e.g. `messages[2].content`.
   * Surfaces as OpenAI's `param` so a client can point at the right input
   * instead of only showing a sentence.
   */
  param?: string;
  /**
   * Safe, client-facing extras attached by the gateway or a guard (for example
   * `retryAfterSeconds` on a rate-limit rejection). Must never contain a
   * credential, a database message, or an internal identifier.
   */
  details?: Record<string, string | number | boolean>;
}

export class GatewayError extends Error {
  public readonly code: GatewayErrorCode;
  public readonly category: GatewayErrorCategory;
  public readonly status: number;
  public readonly upstreamStatus?: number;
  /** Provider id the failure came from, when there was one. */
  public readonly provider?: string;
  /** Model id involved, when the failure is model-scoped. */
  public readonly model?: string;
  /** Request field the caller got wrong. Reported as OpenAI's `param`. */
  public readonly param?: string;
  /** Safe, client-facing extras (e.g. rate-limit retry hints). Never secrets. */
  public readonly details?: Record<string, string | number | boolean>;

  constructor(code: GatewayErrorCode, message: string, options: GatewayErrorOptions = {}) {
    super(sanitize(message));
    this.name = "GatewayError";
    this.code = code;
    this.category = options.category ?? "unknown";
    this.status = options.status ?? STATUS[code];
    this.upstreamStatus = options.upstreamStatus;
    this.provider = options.provider;
    this.model = options.model;
    this.param = options.param;
    if (options.details) {
      // Copied rather than referenced, so a caller cannot mutate it later.
      this.details = Object.freeze({ ...options.details });
    }
    if (options.cause) {
      // Non-enumerable: serializers can never emit the raw cause.
      Object.defineProperty(this, "cause", { value: options.cause, enumerable: false });
    }
  }

  /** Retry the *same* provider+model? Only genuinely transient failures. */
  public get retryableSameProvider(): boolean {
    return (
      this.category === "timeout" ||
      this.category === "rate_limit" ||
      this.category === "temporary_upstream_failure"
    );
  }

  /**
   * Move on to the next eligible candidate?
   *
   * A cancelled request and a bad request stop immediately. A permanent
   * configuration failure is reported instead of being masked by another
   * provider, because the operator has to see the misconfiguration.
   */
  public get canFallback(): boolean {
    switch (this.category) {
      case "cancelled":
      case "invalid_request":
      case "permanent_configuration_failure":
        return false;
      default:
        return true;
    }
  }

  /** Whether this failure says anything about the provider's overall health. */
  public get isProviderHealthFailure(): boolean {
    return this.category !== "invalid_request" && this.category !== "cancelled";
  }

  public toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      category: this.category,
      status: this.status,
      message: this.message,
      provider: this.provider,
      model: this.model,
      ...(this.param ? { param: this.param } : {}),
    };
  }
}

export function isGatewayError(value: unknown): value is GatewayError {
  return value instanceof GatewayError;
}

/** OpenAI-compatible error envelope. Never leaks internals. */
export function toOpenAIError(error: GatewayError): {
  status: number;
  body: {
    error: {
      message: string;
      type: string;
      code: string;
      param: string | null;
      nexa_category: GatewayErrorCategory;
      nexa_provider?: string;
      nexa_model?: string;
    };
  };
} {
  return {
    status: error.status,
    body: {
      error: {
        message: error.message,
        type: OPENAI_TYPE[error.code],
        code: error.code,
        // `param` is the field the caller must fix. Real information, not a stub.
        param: error.param ?? null,
        nexa_category: error.category,
        ...(error.provider ? { nexa_provider: error.provider } : {}),
        ...(error.model ? { nexa_model: error.model } : {}),
      },
    },
  };
}

export function httpStatusToCategory(status: number): GatewayErrorCategory {
  if (status === 401 || status === 403) return "authentication_failure";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limit";
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 404) return "invalid_model";
  if (status >= 500) return "temporary_upstream_failure";
  return "unknown";
}

export function categoryToCode(
  category: GatewayErrorCategory,
  scope: "provider" | "model"
): GatewayErrorCode {
  switch (category) {
    case "authentication_failure":
      return "ProviderAuthenticationError";
    case "timeout":
      return "ProviderTimeout";
    case "rate_limit":
      return "RateLimited";
    case "invalid_model":
      return "ModelNotFound";
    case "invalid_request":
      return "InvalidRequest";
    case "permanent_configuration_failure":
      return "ProviderUnavailable";
    case "cancelled":
      return "GatewayError";
    default:
      return scope === "model" ? "ModelUnavailable" : "ProviderUnavailable";
  }
}
