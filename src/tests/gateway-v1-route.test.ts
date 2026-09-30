/**
 * NEXA AI Gateway — `/v1/chat/completions` route behaviour.
 *
 * The gateway and the provider adapters are stubbed, so this exercises the
 * route's own contract: authentication, the OpenAI frame sequence, the
 * `[DONE]` sentinel, and — most importantly — that a stream which fails *after*
 * content was already delivered reports the failure instead of restarting on
 * another provider and duplicating the answer.
 *
 * The rate limiter is stubbed to admit every request. It lives in PostgreSQL,
 * and without this seam these unit tests would depend on a live database and
 * fail closed (503) whenever one was absent — a failure that says nothing
 * about the frame contract they exist to check. Limiter behaviour is covered
 * separately in `rate-limit.test.ts` (decision logic), `rate-limit-routes.test.ts`
 * (route ordering and responses), and `integration-rate-limit.mts` (real
 * PostgreSQL, real concurrency).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SseDecoder } from "@/lib/gateway/sse";
import { GatewayError } from "@/lib/gateway/errors";
import type { ChatChunk, ChatResponse, RoutingMetadata } from "@/lib/gateway/types";

const chat = vi.fn();
const streamChat = vi.fn();

vi.mock("@/lib/gateway/api-auth", () => ({
  requireApiKey: vi.fn(async () => ({
    keyId: "key_1",
    userId: "user_1",
    displayPrefix: "nexa_sk_test…",
  })),
}));

vi.mock("@/lib/gateway/gateway", () => ({
  NexaGateway: {
    chat: (...args: unknown[]) => chat(...args),
    streamChat: (...args: unknown[]) => streamChat(...args),
  },
}));

// Always admit. See the note at the top of this file.
vi.mock("@/lib/gateway/rate-limit-guard", () => ({
  enforceRateLimit: vi.fn(async () => ({
    allowed: true,
    retryAfterSeconds: 0,
    limit: 60,
    remaining: 59,
    storeUnavailable: false,
    deniedByStoreFailure: false,
  })),
  isRateLimitRejection: () => false,
  rateLimitHeadersFor: () => ({}),
}));

const { POST } = await import("@/app/v1/chat/completions/route");

function routing(model = "m1", provider = "ollama"): RoutingMetadata {
  const id = provider as RoutingMetadata["selectedProvider"];
  return {
    requestedModel: "auto",
    selectedProvider: id,
    selectedModel: model,
    strategy: "auto",
    reason: "test",
    candidates: [{ provider: id, model, reason: "test" }],
    attempts: [],
    fallbackUsed: false,
  };
}

function completion(content: string): ChatResponse {
  return {
    id: "chatcmpl_1",
    model: "m1",
    provider: "ollama",
    content,
    finishReason: "stop",
    usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8, estimated: false },
    latencyMs: 12,
    createdAt: 1_700_000_000,
    routing: routing(),
  };
}

/**
 * The terminal OpenAI sentinel, as a distinct marker rather than a string, so
 * it can never be confused with a real payload in a comparison.
 */
const DONE = Symbol("DONE");
type Frame = Record<string, any> | typeof DONE;

/** Collect every SSE frame of a response body, as parsed objects. */
async function readFrames(response: Response): Promise<Frame[]> {
  const bytes = new TextEncoder().encode(await response.text());
  const sse = new SseDecoder();
  const events = [...sse.decode(bytes), ...sse.flush()];
  return events.map((event) =>
    event.data === "[DONE]" ? DONE : (JSON.parse(event.data) as Record<string, any>)
  );
}

/** Every real chunk frame, excluding the terminal sentinel. */
function chunkFrames(frames: Frame[]): Record<string, any>[] {
  return frames.filter(
    (frame): frame is Record<string, any> => frame !== DONE && frame.object === "chat.completion.chunk"
  );
}

/** Concatenate every content delta in a frame list. */
function textOf(frames: Frame[]): string {
  return chunkFrames(frames)
    .map((f) => f.choices[0].delta.content)
    .filter((c) => c !== undefined)
    .join("");
}

function chatRequest(body: unknown): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer nexa_sk_test" },
    body: JSON.stringify(body),
  });
}

/** Drive a stubbed async generator through the route. */
async function* fromChunks(chunks: ChatChunk[]): AsyncIterable<ChatChunk> {
  for (const chunk of chunks) yield chunk;
}

const VALID_BODY = { model: "auto", messages: [{ role: "user", content: "hi" }] };
const UPSTREAM_FAILURE = new GatewayError("ProviderUnavailable", "connection reset", {
  category: "temporary_upstream_failure",
});

beforeEach(() => {
  chat.mockReset();
  streamChat.mockReset();
});

describe("POST /v1/chat/completions", () => {
  it("returns an OpenAI-shaped completion without streaming", async () => {
    chat.mockResolvedValue(completion("Hello world"));

    const response = await POST(chatRequest(VALID_BODY));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, any>;
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("Hello world");
    expect(body.choices[0].finish_reason).toBe("stop");
    // Usage is always present: an SDK reading it must never see undefined.
    expect(body.usage).toEqual({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
  });

  it("rejects a bad request with 400 and the offending field, before any streaming", async () => {
    const response = await POST(chatRequest({ model: "auto", messages: [] }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { param: string; type: string } };
    expect(body.error.param).toBe("messages");
    expect(body.error.type).toBe("invalid_request_error");
    // The provider must never have been contacted.
    expect(chat).not.toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("surfaces an upstream failure as a real HTTP status when not streaming", async () => {
    chat.mockRejectedValue(
      new GatewayError("RateLimited", "Too many requests.", { category: "rate_limit" })
    );
    const response = await POST(chatRequest(VALID_BODY));
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe("rate_limited");
  });

  it("emits a role frame, content deltas, a final frame with usage, then [DONE]", async () => {
    streamChat.mockReturnValue(
      fromChunks([
        { type: "token", content: "Hello" },
        { type: "token", content: " world" },
        { type: "done", data: completion("Hello world") },
      ])
    );

    const response = await POST(chatRequest({ ...VALID_BODY, stream: true }));
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const frames = await readFrames(response);
    // The sentinel always terminates the stream.
    expect(frames[frames.length - 1]).toBe(DONE);

    const chunks = chunkFrames(frames);
    expect(chunks.length).toBeGreaterThan(0);

    // The role arrives once, before any content.
    const roleIndex = chunks.findIndex((c) => c.choices[0].delta.role === "assistant");
    const firstContent = chunks.findIndex((c) => c.choices[0].delta.content);
    expect(roleIndex).toBeGreaterThanOrEqual(0);
    expect(roleIndex).toBeLessThan(firstContent);

    // Content is forwarded exactly once, in order.
    expect(textOf(frames)).toBe("Hello world");

    // The terminal frame carries finish_reason and usage.
    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.usage.total_tokens).toBe(8);
  });

  it("never forwards an empty delta", async () => {
    streamChat.mockReturnValue(
      fromChunks([
        { type: "token", content: "" },
        { type: "reasoning", content: "" },
        { type: "token", content: "Hello" },
        { type: "token", content: "" },
        { type: "done", data: completion("Hello") },
      ])
    );

    const response = await POST(chatRequest({ ...VALID_BODY, stream: true }));
    const deltas = chunkFrames(await readFrames(response))
      // The opening role frame carries `content: ""` by OpenAI convention; it
      // is not a content delta.
      .filter((f) => f.choices[0].delta.role === undefined)
      .flatMap((f) => [f.choices[0].delta.content, f.choices[0].delta.reasoning_content])
      .filter((d) => d !== undefined);
    expect(deltas).toEqual(["Hello"]);
  });

  it("does not forward NEXA-internal action frames as assistant text", async () => {
    streamChat.mockReturnValue(
      fromChunks([
        { type: "action", content: "NEXA gateway: routing" },
        { type: "token", content: "Hello" },
        { type: "done", data: completion("Hello") },
      ])
    );

    const response = await POST(chatRequest({ ...VALID_BODY, stream: true }));
    // The action text must not appear as content, or an OpenAI client renders
    // it as part of the answer.
    expect(textOf(await readFrames(response))).toBe("Hello");
  });

  it("reports a mid-stream failure in-band and still terminates the stream", async () => {
    streamChat.mockReturnValue(
      fromChunks([
        { type: "token", content: "Partial" },
        { type: "error", content: "connection reset", data: UPSTREAM_FAILURE },
      ])
    );

    const response = await POST(chatRequest({ ...VALID_BODY, stream: true }));
    // The 200 is already on the wire, so the error is an in-band frame.
    expect(response.status).toBe(200);

    const frames = await readFrames(response);
    // [DONE] is sent even after an error, so a client waiting on the sentinel
    // always terminates instead of hanging.
    expect(frames[frames.length - 1]).toBe(DONE);

    const errorFrame = frames.find(
      (f) => f !== DONE && f.object === "error"
    ) as Record<string, any> | undefined;
    expect(errorFrame).toBeDefined();
    expect(errorFrame?.error.message).toBe("connection reset");
  });

  it("does not duplicate content when a provider fails after sending some", async () => {
    // The regression this whole migration exists for: a fallback after content
    // was delivered re-streams the answer from the top.
    streamChat.mockReturnValue(
      fromChunks([
        { type: "token", content: "The answer is 4" },
        { type: "error", content: "connection reset", data: UPSTREAM_FAILURE },
      ])
    );

    const response = await POST(chatRequest({ ...VALID_BODY, stream: true }));
    expect(textOf(await readFrames(response))).toBe("The answer is 4");
  });
});
