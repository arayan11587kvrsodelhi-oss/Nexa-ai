import { NextResponse } from "next/server";
import { ZodError } from "zod";

/**
 * The single place API failures become responses.
 *
 * Two rules, both non-negotiable:
 *
 *  1. The user-facing `error` string is a fixed, human sentence. It never
 *     contains a driver message, a SQL fragment, a table or column name, a
 *     connection string, a file path, or a stack frame.
 *  2. The raw cause is kept, but only in `detail`, and only when the caller
 *     asked for it via `X-NEXA-Debug: 1` (a server-operator header the browser
 *     never sends). Even then it is truncated.
 *
 * Routes throw `ApiError` and let `toErrorResponse` render it; they never build
 * an error payload by hand.
 */

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "DATABASE_UNAVAILABLE"
  | "VALIDATION_FAILED"
  | "INTERNAL";

const STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 503,
  DATABASE_UNAVAILABLE: 503,
  VALIDATION_FAILED: 422,
  INTERNAL: 500,
};

/**
 * Default copy is intentionally user-ready: these strings are what the UI shows
 * when a route does not supply something more specific.
 */
const DEFAULT_MESSAGE: Record<ApiErrorCode, string> = {
  BAD_REQUEST: "That request could not be understood.",
  UNAUTHORIZED: "You need to sign in to do that.",
  FORBIDDEN: "You do not have access to this resource.",
  NOT_FOUND: "We could not find what you were looking for.",
  CONFLICT: "That conflicts with something that already exists.",
  PAYLOAD_TOO_LARGE: "That file is too large to process.",
  UNSUPPORTED_MEDIA_TYPE: "That file type is not supported.",
  RATE_LIMITED: "Too many requests. Please wait a moment and try again.",
  UPSTREAM_UNAVAILABLE:
    "The upstream service is not reachable right now. Check the provider configuration.",
  DATABASE_UNAVAILABLE: "Database connection unavailable.",
  VALIDATION_FAILED: "Some of the provided values were not valid.",
  INTERNAL: "Something went wrong on our side.",
};

export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly status: number;
  public readonly userMessage: string;
  public readonly fields?: Record<string, string>;

  constructor(
    code: ApiErrorCode,
    options: {
      /** Safe, user-facing sentence. Never derived from a caught exception. */
      message?: string;
      /** Raw cause, for server logs and the debug header only. */
      cause?: unknown;
      fields?: Record<string, string>;
    } = {}
  ) {
    const raw =
      options.cause instanceof Error
        ? options.cause.message
        : typeof options.cause === "string"
          ? options.cause
          : undefined;

    super(raw || DEFAULT_MESSAGE[code]);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS[code];
    this.userMessage = options.message || DEFAULT_MESSAGE[code];
    this.fields = options.fields;
  }

  static badRequest(message?: string, cause?: unknown) {
    return new ApiError("BAD_REQUEST", { message, cause });
  }
  static unauthorized(message?: string) {
    return new ApiError("UNAUTHORIZED", { message });
  }
  static forbidden(message?: string) {
    return new ApiError("FORBIDDEN", { message });
  }
  static notFound(message?: string) {
    return new ApiError("NOT_FOUND", { message });
  }
  static rateLimited(message?: string) {
    return new ApiError("RATE_LIMITED", { message });
  }
  static databaseUnavailable(cause?: unknown) {
    return new ApiError("DATABASE_UNAVAILABLE", { cause });
  }
  static upstream(message?: string, cause?: unknown) {
    return new ApiError("UPSTREAM_UNAVAILABLE", { message, cause });
  }
  static internal(cause?: unknown) {
    return new ApiError("INTERNAL", { cause });
  }
}

/** Does an unknown thrown value look like a database connectivity failure? */
function looksLikeDatabaseFailure(message: string): boolean {
  return (
    message.includes("Database connection unavailable") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ENOTFOUND") ||
    message.includes("ETIMEDOUT") ||
    message.includes("Connection terminated") ||
    message.includes("timeout exceeded when trying to connect") ||
    message.includes("password authentication failed") ||
    // Schema not migrated yet: relation "x" does not exist
    message.includes('relation "') ||
    message.includes("column ")
  );
}

const DEBUG_HEADER = "x-nexa-debug";

export interface ErrorResponseOptions {
  /** Request used to read the debug header. Optional. */
  request?: Request;
}

/**
 * Convert any thrown value into a sanitized response.
 *
 * Unknown errors are assumed to be internal, and are mapped to the database
 * message only when their text matches a known connectivity signature.
 */
export function toErrorResponse(
  error: unknown,
  options: ErrorResponseOptions = {}
): NextResponse {
  const wantsDebug =
    options.request?.headers.get(DEBUG_HEADER)?.trim() === "1" &&
    process.env.NODE_ENV !== "production";

  if (error instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".") || "_";
      if (!fields[key]) fields[key] = issue.message;
    }
    return NextResponse.json(
      {
        error: DEFAULT_MESSAGE.VALIDATION_FAILED,
        code: "VALIDATION_FAILED",
        fields,
      },
      { status: STATUS.VALIDATION_FAILED }
    );
  }

  if (error instanceof ApiError) {
    return NextResponse.json(
      {
        error: error.userMessage,
        code: error.code,
        ...(error.fields ? { fields: error.fields } : {}),
        ...(wantsDebug ? { detail: error.message.slice(0, 800) } : {}),
      },
      { status: error.status }
    );
  }

  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  // Server-side record of what actually happened. This is the only place the
  // raw cause is allowed to travel.
  console.error("[nexa] unhandled API error:", error);

  const code: ApiErrorCode = looksLikeDatabaseFailure(raw)
    ? "DATABASE_UNAVAILABLE"
    : "INTERNAL";

  return NextResponse.json(
    {
      error: DEFAULT_MESSAGE[code],
      code,
      ...(wantsDebug ? { detail: raw.slice(0, 800) } : {}),
    },
    { status: STATUS[code] }
  );
}

/** Convenience for the very common "the database is not answering" case. */
export function databaseUnavailableResponse(cause?: unknown) {
  return toErrorResponse(ApiError.databaseUnavailable(cause));
}