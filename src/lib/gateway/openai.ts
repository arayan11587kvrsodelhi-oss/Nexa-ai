/**
 * NEXA AI Gateway — OpenAI-compatible wire format.
 *
 * The `/v1/*` surface has to be compatible with what OpenAI clients already
 * speak, so a client can be repointed at NEXA by changing one base URL. That
 * means `chat.completion` / `chat.completion.chunk` shapes with
 * `choices[0].delta`, a populated `usage`, a terminal `data: [DONE]`, and an
 * `error: { message, type, code, param }` envelope for every failure.
 *
 * NEXA-specific detail (which provider answered, the routing chain) is exposed
 * under a `nexa_routing` key rather than by breaking the schema. Clients that
 * don't know the key ignore it.
 */
import type { GatewayError } from "./errors";
import { toOpenAIError } from "./errors";
import type { ChatChunk, ChatResponse, ChatUsage } from "./types";

/**
 * `GET /v1/models` uses `GatewayModelRegistry.toOpenAIModels`, which already
 * carries the richer NEXA extensions (`nexa_pinned_id`, `nexa_context_length`,
 * `nexa_last_health_check`). This module deliberately owns only the
 * completions wire format, so there is exactly one projection per payload.
 */

function openaiUsage(usage: ChatUsage | null): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const prompt = usage?.promptTokens ?? 0;
  const completion = usage?.completionTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage?.totalTokens ?? prompt + completion,
  };
}

const FINISH_REASON: Record<ChatResponse["finishReason"], string> = {
  stop: "stop",
  length: "length",
  // OpenAI has no "failed" finish reason; the error itself is what matters.
  error: "stop",
  cancelled: "stop",
};

/** Non-streaming `chat.completion`. */
export function toOpenAICompletion(response: ChatResponse): Record<string, unknown> {
  return {
    id: response.id,
    object: "chat.completion",
    created: response.createdAt,
    model: response.model,
    provider: response.provider,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: response.content,
          ...(response.reasoning ? { reasoning_content: response.reasoning } : {}),
        },
        finish_reason: FINISH_REASON[response.finishReason],
      },
    ],
    usage: openaiUsage(response.usage),
    nexa_routing: response.routing,
  };
}

export interface OpenAIStreamContext {
  id: string;
  created: number;
  model: string;
  provider: string;
}

function toChunkFrame(input: {
  id: string;
  created: number;
  model: string;
  provider: string;
  delta: Record<string, unknown>;
  finishReason: string | null;
  usage?: ChatUsage | null;
}): Record<string, unknown> {
  return {
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
    provider: input.provider,
    choices: [
      {
        index: 0,
        delta: input.delta,
        finish_reason: input.finishReason,
      },
    ],
    // Only the terminal frame carries usage; an intermediate frame must not
    // claim a total of zero.
    ...(input.usage !== undefined ? { usage: openaiUsage(input.usage) } : {}),
  };
}

/** The opening frame: announces the role, carries no content. */
export function toChunkRoleFrame(context: OpenAIStreamContext): Record<string, unknown> {
  return toChunkFrame({
    ...context,
    delta: { role: "assistant", content: "" },
    finishReason: null,
  });
}

/** A content or reasoning delta. */
export function toChunkDeltaFrame(
  context: OpenAIStreamContext,
  chunk: Extract<ChatChunk, { type: "token" | "reasoning" }>
): Record<string, unknown> {
  const delta =
    chunk.type === "reasoning" ? { reasoning_content: chunk.content } : { content: chunk.content };
  return toChunkFrame({ ...context, delta, finishReason: null });
}

/**
 * The terminal frame.
 *
 * `usage` is always sent, even when null: the OpenAI SDKs only populate usage
 * when the last frame carries it, so omitting the key makes downstream cost
 * tracking silently read zero.
 */
export function toChunkFinalFrame(
  context: OpenAIStreamContext,
  response: ChatResponse
): Record<string, unknown> {
  return toChunkFrame({
    ...context,
    delta: {},
    finishReason: FINISH_REASON[response.finishReason],
    usage: response.usage ?? null,
  });
}

/**
 * Mid-stream failure.
 *
 * The status line was already sent as 200, so the only way to report this is
 * in-band. The frame is an `error` object (not a chunk with an empty delta),
 * which is what the OpenAI clients surface to the caller.
 */
export function toChunkErrorFrame(
  context: OpenAIStreamContext,
  error: GatewayError
): Record<string, unknown> {
  return {
    ...toOpenAIError(error).body,
    id: context.id,
    object: "error",
    created: context.created,
    model: context.model,
    provider: context.provider,
  };
}

/** Non-streaming error envelope, for failures detected before any byte is sent. */
export function errorResponse(error: GatewayError): {
  status: number;
  body: Record<string, unknown>;
} {
  return toOpenAIError(error);
}
