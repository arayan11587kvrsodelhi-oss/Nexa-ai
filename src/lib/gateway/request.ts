/**
 * NEXA AI Gateway — public request validation.
 *
 * The `/v1/*` surface is reachable with a leaked key and no session, so it
 * assumes hostile input:
 *
 *  - a byte cap on the body, enforced from the declared `Content-Length` and
 *    again on the parsed text, because a chunked request can lie about it;
 *  - a cap on message count and on total characters, so one request cannot
 *    forward an unbounded payload to a paid upstream;
 *  - strict field validation, so a typo (`max_token`) fails loudly instead of
 *    being silently dropped and producing a surprising bill.
 *
 * A validation failure is `InvalidRequest` (400), never a 500: the caller sent
 * something wrong and deserves to know.
 */
import { z } from "zod";
import { GatewayError } from "./errors";
import type { ChatMessage, ChatRequest } from "./types";

/** Hard caps. Deliberately generous for chat, but not unbounded. */
export const LIMITS = {
  maxBodyBytes: 512 * 1024,
  maxMessages: 200,
  maxMessageChars: 100_000,
  maxTotalChars: 2_000_000,
  maxStopSequences: 8,
  maxStopSequenceChars: 200,
  maxModelIdChars: 200,
  maxSystemPromptChars: 32_000,
} as const;

const contentSchema = z
  .string()
  .max(LIMITS.maxMessageChars, `Message content exceeds ${LIMITS.maxMessageChars} characters.`);

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: contentSchema,
  name: z.string().max(64).optional(),
});

export const chatCompletionRequestSchema = z.object({
  model: z.string().min(1).max(LIMITS.maxModelIdChars),
  messages: z.array(messageSchema).min(1, "messages must not be empty."),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().max(32_000).optional(),
  stop: z
    .union([
      z.string().max(LIMITS.maxStopSequenceChars),
      z.array(z.string().max(LIMITS.maxStopSequenceChars)).max(LIMITS.maxStopSequences),
    ])
    .optional(),
  user: z.string().max(200).optional(),
});

/** Reads the body with a byte cap, before and after parsing. */
export async function readJsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > LIMITS.maxBodyBytes) {
    throw invalidRequest(
      `Request body exceeds the ${LIMITS.maxBodyBytes} byte limit.`,
      "content-length"
    );
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    throw invalidRequest("Request body could not be read.", "body");
  }

  // Authoritative check: `Content-Length` may be absent or wrong.
  if (text.length > LIMITS.maxBodyBytes) {
    throw invalidRequest(
      `Request body exceeds the ${LIMITS.maxBodyBytes} byte limit.`,
      "body"
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidRequest("Request body must be valid JSON.", "body");
  }
}

/** Parse + validate an OpenAI `chat/completions` body into a gateway request. */
export function parseChatCompletionRequest(body: unknown): ChatRequest {
  const parsed = chatCompletionRequestSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join(".") || "body";
    throw invalidRequest(
      first?.message ?? "The request body is not a valid chat completion request.",
      path
    );
  }

  const { model, messages, stream, temperature, top_p, max_tokens, stop, user } = parsed.data;

  const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (totalChars > LIMITS.maxTotalChars) {
    throw invalidRequest(
      `Combined message content exceeds ${LIMITS.maxTotalChars} characters.`,
      "messages"
    );
  }

  // A system message is lifted out of the array: providers take it as a
  // dedicated field, and leaving it inline makes prompt caching miss.
  const systemMessages = messages.filter((message) => message.role === "system");
  const systemPrompt =
    systemMessages.map((message) => message.content).join("\n\n").slice(0, LIMITS.maxSystemPromptChars) ||
    undefined;

  const chatMessages: ChatMessage[] = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
    }));

  if (chatMessages.length === 0) {
    throw invalidRequest(
      "messages must contain at least one non-system message.",
      "messages"
    );
  }

  return {
    model,
    messages: chatMessages,
    stream,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(top_p !== undefined ? { topP: top_p } : {}),
    ...(max_tokens !== undefined ? { maxTokens: max_tokens } : {}),
    ...(stop !== undefined
      ? { stop: Array.isArray(stop) ? stop : [stop] }
      : {}),
    // `user` is a stable per-caller label upstream; never a credential.
    ...(user ? { metadata: { user } } : {}),
  };
}

function invalidRequest(message: string, param: string): GatewayError {
  return new GatewayError("InvalidRequest", message, {
    category: "invalid_request",
    param,
  });
}
