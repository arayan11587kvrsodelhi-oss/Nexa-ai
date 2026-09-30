/**
 * NEXA AI Gateway — core invariants.
 *
 * These tests never touch a network or a database. They cover the guarantees
 * the gateway exists to provide:
 *
 *  1. SSE framing survives hostile chunk boundaries, so a frame split across
 *     two network reads is never parsed early and never duplicated.
 *  2. Empty and snapshot frames cannot create content, so no duplicated or
 *     empty Markdown blocks reach the UI.
 *  3. Retry/fallback is bounded and only happens for transient failures.
 *  4. Errors are classified, sanitized, and mapped onto the right HTTP status.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { SseDecoder, encodeSseData, isDoneSentinel } from "@/lib/gateway/sse";
import { ContentAccumulator, appendContentDelta, isBlankContent } from "@/lib/gateway/content";
import { GatewayError, sanitize, toOpenAIError } from "@/lib/gateway/errors";
import { runWithFallback } from "@/lib/gateway/retry";
import { modelsFromIds } from "@/lib/gateway/providers/shared";
import { parseChatCompletionRequest, LIMITS } from "@/lib/gateway/request";
import {
  generateApiKey,
  extractBearerToken,
  isNexaApiKeyFormat,
  hashApiKey,
  NEXA_API_KEY_PREFIX,
} from "@/lib/gateway/api-keys";

const encoder = new TextEncoder();

/** Feed a string through the decoder in fixed-size byte slices. */
function decodeInSlices(input: string, size: number): string[] {
  const sse = new SseDecoder();
  const bytes = encoder.encode(input);
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    for (const event of sse.decode(bytes.slice(i, i + size))) out.push(event.data);
  }
  for (const event of sse.flush()) out.push(event.data);
  return out;
}

describe("SSE decoding", () => {
  it("decodes identically no matter where the chunk boundaries fall", () => {
    // Comments, CRLF, a multi-line payload, and a [DONE] sentinel.
    const stream =
      ": keep-alive\r\n\r\n" +
      'data: {"delta":"Hello"}\r\n\r\n' +
      'data: {"a":1,\r\ndata: "b":2}\r\n\r\n' +
      "data: [DONE]\n\n";

    const reference = decodeInSlices(stream, stream.length);
    expect(reference).toEqual(['{"delta":"Hello"}', '{"a":1,\n"b":2}', "[DONE]"]);

    // Every slice size, including one byte at a time (the worst case).
    for (const size of [1, 2, 3, 7, 16, 31, 64]) {
      expect(decodeInSlices(stream, size), `slice size ${size}`).toEqual(reference);
    }
  });

  it("does not turn an event with no data field into content", () => {
    const sse = new SseDecoder();
    const events = sse.decode(encoder.encode("event: ping\n\ndata:\n\ndata: real\n\n"));
    // An empty `data:` event carries nothing. It must never become an empty
    // token, and an empty token becomes an empty Markdown block in the UI.
    expect(events.map((e) => e.data)).toEqual(["", "real"]);
  });

  it("preserves a multi-byte character split across a chunk boundary", () => {
    const bytes = encoder.encode("data: 你好\n\n");
    // Split in the middle of the 3-byte character.
    const cut = bytes.indexOf(0xe5) + 1;
    const sse = new SseDecoder();
    const first = sse.decode(bytes.slice(0, cut));
    const second = sse.decode(bytes.slice(cut));
    expect([...first, ...second].map((e) => e.data)).toEqual(["你好"]);
  });

  it("recognises the [DONE] sentinel", () => {
    expect(isDoneSentinel("[DONE]")).toBe(true);
    expect(isDoneSentinel(" [DONE] ")).toBe(true);
    expect(isDoneSentinel('{"choices":[]}')).toBe(false);
  });

  it("round-trips an encoded frame", () => {
    const sse = new SseDecoder();
    const events = sse.decode(encodeSseData({ hello: "world" }));
    expect(JSON.parse(events[0].data)).toEqual({ hello: "world" });
  });
});

describe("content accumulation", () => {
  it("applies a snapshot frame once, not once per frame", () => {
    // The defect this exists for: the whole reply repeated in every frame.
    let accumulated = "";
    for (const snapshot of ["Hel", "Hello", "Hello world"]) {
      accumulated = appendContentDelta(accumulated, snapshot).next;
    }
    expect(accumulated).toBe("Hello world");
  });

  it("ignores empty frames so they cannot create Markdown", () => {
    expect(appendContentDelta("text", "")).toEqual({
      next: "text",
      kind: "ignored",
      emitted: "",
      reason: "empty",
    });
  });

  it("emits only the new suffix of a snapshot frame", () => {
    // This is the streaming contract: a consumer that already rendered "Hello"
    // must be told only about " world", never the whole snapshot again.
    expect(appendContentDelta("Hello", "Hello world")).toEqual({
      next: "Hello world",
      kind: "snapshot",
      emitted: " world",
    });
    expect(appendContentDelta("", "Hello")).toEqual({
      next: "Hello",
      kind: "append",
      emitted: "Hello",
    });
  });

  it("emits nothing for a duplicate or a stale snapshot", () => {
    expect(appendContentDelta("abc", "abc").emitted).toBe("");
    expect(appendContentDelta("abcdef", "abc").emitted).toBe("");
  });

  it("ignores an exact duplicate and a stale snapshot", () => {
    expect(appendContentDelta("abc", "abc").kind).toBe("ignored");
    expect(appendContentDelta("abcdef", "abc").kind).toBe("ignored");
  });

  it("appends genuine deltas", () => {
    expect(appendContentDelta("", "Hel")).toEqual({
      next: "Hel",
      kind: "append",
      emitted: "Hel",
    });
    expect(appendContentDelta("Hel", "lo")).toEqual({
      next: "Hello",
      kind: "append",
      emitted: "lo",
    });
  });

  it("delivers a replayed stream to a consumer exactly once", () => {
    // The end-to-end property, asserted over the emitted pieces.
    const snapshotFrames = ["Hel", "Hello", "Hello world", "Hello world"];
    let delivered = "";
    for (const frame of snapshotFrames) {
      delivered += appendContentDelta(delivered, frame).emitted;
    }
    expect(delivered).toBe("Hello world");
  });

  it("counts what was applied versus dropped", () => {
    const accumulator = new ContentAccumulator();
    accumulator.appendToken("Hello");
    accumulator.appendToken("Hello"); // duplicate snapshot
    accumulator.appendToken(""); // empty
    accumulator.appendToken(" world");
    expect(accumulator.text).toBe("Hello world");
    expect(accumulator.applied).toBe(2);
    expect(accumulator.duplicates).toBe(1);
    expect(accumulator.empty).toBe(1);
  });

  it("treats whitespace-only content as blank", () => {
    expect(isBlankContent("   \n\t")).toBe(true);
    expect(isBlankContent("x")).toBe(false);
  });
});

describe("Regression: provider-reported context windows reach the registry", () => {
  it("carries a reported context length through and leaves unreported ones null", () => {
    // The adapter used to drop contextWindow when building ModelInfo, so every
    // FreeLLMAPI model reported "not reported" even when the provider said
    // 8192. Nothing is invented: a model the provider said nothing about stays
    // null.
    const models = modelsFromIds("freellmapi", ["vendor/a", "vendor/b"], {
      requiresApiKey: false,
      supportsStreaming: true,
      contextLengths: { "vendor/a": 8192 },
    });
    expect(models.find((m) => m.id === "vendor/a")?.contextLength).toBe(8192);
    expect(models.find((m) => m.id === "vendor/b")?.contextLength).toBeNull();
  });

  it("ignores a nonsensical reported value rather than storing it", () => {
    const models = modelsFromIds("freellmapi", ["vendor/a"], {
      requiresApiKey: false,
      supportsStreaming: true,
      contextLengths: { "vendor/a": 0 },
    });
    expect(models[0].contextLength).toBeNull();
  });
});

describe("Regression: done.content matches what the client received", () => {
  it("does not re-concatenate cumulative snapshot frames in the done frame", async () => {
    // A provider that echoes the whole reply every frame produced
    // "HelloHello worldHello world!" in `done.content` even though the tokens
    // were delivered correctly. The accumulator is the authority.
    const { bridgeLegacyStream } = await import("@/lib/gateway/providers/shared");
    const routing = () => ({
      requestedModel: "vendor/a",
      selectedProvider: "freellmapi" as const,
      selectedModel: "vendor/a",
      strategy: "explicit" as const,
      reason: "test",
      candidates: [],
      attempts: [],
      fallbackUsed: false,
    });
    const adapter = {
      id: "stub",
      name: "stub",
      type: "custom" as const,
      baseUrl: "http://stub.invalid",
      testConnection: async () => ({ ok: true, message: "" }),
      listModels: async () => [],
      generateStream: async (
        _options: unknown,
        emit: (e: { type: string; content: string }) => void
      ) => {
        for (const snapshot of ["Hello", "Hello world", "Hello world!"]) {
          emit({ type: "token", content: snapshot });
        }
        // The provider's own echo is the naive concatenation.
        return { fullText: "HelloHello worldHello world!", latencyMs: 1 };
      },
    };

    const events: any[] = [];
    for await (const chunk of bridgeLegacyStream(
      "freellmapi",
      adapter as never,
      { model: "vendor/a", messages: [{ role: "user", content: "hi" }], stream: true },
      "vendor/a",
      routing
    )) {
      events.push(chunk);
    }

    const delivered = events
      .filter((e) => e.type === "token")
      .map((e) => e.content)
      .join("");
    expect(delivered).toBe("Hello world!");
    const done = events.find((e) => e.type === "done");
    // The terminal frame must agree with what was streamed.
    expect(done.data.content).toBe("Hello world!");
    expect(done.data.content).toBe(delivered);
  });
});

describe("error taxonomy", () => {
  it("maps categories onto the documented HTTP statuses", () => {
    const timeout = new GatewayError("ProviderTimeout", "slow", { category: "timeout" });
    const rate = new GatewayError("RateLimited", "busy", { category: "rate_limit" });
    const notFound = new GatewayError("ModelNotFound", "gone", { category: "invalid_model" });
    expect(timeout.status).toBe(504);
    expect(rate.status).toBe(429);
    expect(notFound.status).toBe(404);
  });

  it("only treats genuinely transient failures as retryable", () => {
    const transient = new GatewayError("ProviderTimeout", "t", { category: "timeout" });
    const rateLimit = new GatewayError("RateLimited", "r", { category: "rate_limit" });
    const badRequest = new GatewayError("InvalidRequest", "b", { category: "invalid_request" });
    const badModel = new GatewayError("ModelNotFound", "m", { category: "invalid_model" });
    const auth = new GatewayError("ProviderAuthenticationError", "a", {
      category: "authentication_failure",
    });

    expect(transient.retryableSameProvider).toBe(true);
    expect(rateLimit.retryableSameProvider).toBe(true);
    expect(badRequest.retryableSameProvider).toBe(false);
    expect(badModel.retryableSameProvider).toBe(false);
    expect(auth.retryableSameProvider).toBe(false);

    // A misconfiguration is reported, not masked by another provider.
    const misconfigured = new GatewayError("ProviderUnavailable", "bad env", {
      category: "permanent_configuration_failure",
    });
    expect(misconfigured.canFallback).toBe(false);
    expect(transient.canFallback).toBe(true);
  });

  it("strips credentials from anything derived from upstream text", () => {
    const upstream =
      "401 for Authorization: Bearer sk-live-abcdef123456 at https://x/api?api_key=abcd1234";
    const clean = sanitize(upstream);
    expect(clean).not.toContain("sk-live-abcdef123456");
    expect(clean).not.toContain("abcd1234");

    // An exact secret is removed even when no pattern would match it.
    expect(sanitize("token is hunter2xyz-very-secret", ["hunter2xyz-very-secret"])).toBe(
      "token is ***"
    );
  });

  it("produces an OpenAI-shaped error envelope with a real param", () => {
    const error = new GatewayError("InvalidRequest", "messages must not be empty.", {
      category: "invalid_request",
      param: "messages",
    });
    const { status, body } = toOpenAIError(error);
    expect(status).toBe(400);
    expect(body.error).toMatchObject({
      message: "messages must not be empty.",
      type: "invalid_request_error",
      code: "InvalidRequest",
      param: "messages",
    });
  });
});

describe("bounded retry and fallback", () => {
  const targets = [
    { provider: "ollama" as const, model: "a" },
    { provider: "aihorde" as const, model: "b" },
  ];

  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves to the next candidate after a transient failure", async () => {
    const attempted: string[] = [];
    const result = await runWithFallback(
      targets,
      async (target) => {
        attempted.push(target.model);
        if (target.model === "a") {
          throw new GatewayError("ProviderTimeout", "slow", { category: "timeout" });
        }
        return { content: "ok" };
      },
      // No backoff, and no second attempt at the first candidate, so the
      // fallback itself is what this test observes.
      { policy: { maxAttemptsPerCandidate: 1, baseBackoffMs: 0, maxTotalAttempts: 4 } }
    );

    expect(attempted).toEqual(["a", "b"]);
    expect(result.value).toEqual({ content: "ok" });
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts.map((a) => a.outcome)).toEqual(["failed", "success"]);
  });

  it("retries a transient failure against the same target, but only boundedly", async () => {
    const attempted: string[] = [];
    await expect(
      runWithFallback(
        [{ provider: "ollama" as const, model: "a" }],
        async (target) => {
          attempted.push(target.model);
          throw new GatewayError("ProviderTimeout", "slow", { category: "timeout" });
        },
        {
          policy: { maxAttemptsPerCandidate: 2, baseBackoffMs: 0, maxTotalAttempts: 4 },
        }
      )
    ).rejects.toThrow();
    // Exactly the configured bound — never unbounded.
    expect(attempted).toEqual(["a", "a"]);
  });

  it("does not retry a non-transient failure against the same target", async () => {
    const attempted: string[] = [];
    await expect(
      runWithFallback(
        [{ provider: "ollama" as const, model: "a" }],
        async (target) => {
          attempted.push(target.model);
          throw new GatewayError("ModelNotFound", "gone", { category: "invalid_model" });
        },
        {
          policy: { maxAttemptsPerCandidate: 3, baseBackoffMs: 0, maxTotalAttempts: 4 },
        }
      )
    ).rejects.toThrow();
    // Repeating the same call cannot change the answer, so it is not repeated.
    expect(attempted).toEqual(["a"]);
  });

  it("stops immediately on an invalid request", async () => {
    const attempted: string[] = [];
    await expect(
      runWithFallback(
        targets,
        async (target) => {
          attempted.push(target.model);
          throw new GatewayError("InvalidRequest", "bad", { category: "invalid_request" });
        },
        { policy: { maxAttemptsPerCandidate: 1, baseBackoffMs: 0, maxTotalAttempts: 4 } }
      )
    ).rejects.toThrow("bad");
    expect(attempted).toEqual(["a"]);
  });

  it("stops when a stop condition is raised, even for a fallback-able error", async () => {
    const attempted: string[] = [];
    await expect(
      runWithFallback(
        targets,
        async (target) => {
          attempted.push(target.model);
          throw new GatewayError("ProviderUnavailable", "x", {
            category: "temporary_upstream_failure",
          });
        },
        {
          policy: { maxAttemptsPerCandidate: 1, baseBackoffMs: 0, maxTotalAttempts: 4 },
          // e.g. "content was already delivered".
          shouldStop: () => true,
        }
      )
    ).rejects.toThrow();
    expect(attempted).toEqual(["a"]);
  });

  it("honours an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      runWithFallback(
        targets,
        async () => {
          calls += 1;
          return "x";
        },
        { signal: controller.signal }
      )
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
});

describe("/v1 request validation", () => {
  it("accepts a minimal valid request", () => {
    const request = parseChatCompletionRequest({
      model: "auto",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(request.model).toBe("auto");
    expect(request.stream).toBe(false);
    expect(request.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("lifts system messages out of the array", () => {
    const request = parseChatCompletionRequest({
      model: "auto",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    });
    expect(request.systemPrompt).toBe("be brief");
    expect(request.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("rejects a request with no non-system message", () => {
    expect(() =>
      parseChatCompletionRequest({ model: "auto", messages: [{ role: "system", content: "x" }] })
    ).toThrow(/non-system/);
  });

  it("rejects a non-numeric temperature instead of silently ignoring it", () => {
    expect(() =>
      parseChatCompletionRequest({
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        temperature: "hot",
      })
    ).toThrow();
  });

  it("rejects an oversized message", () => {
    const huge = "x".repeat(LIMITS.maxMessageChars + 1);
    expect(() =>
      parseChatCompletionRequest({
        model: "auto",
        messages: [{ role: "user", content: huge }],
      })
    ).toThrow(/exceeds/);
  });

  it("reports the offending field as `param`", () => {
    expect.assertions(3);
    try {
      parseChatCompletionRequest({ messages: [] });
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).status).toBe(400);
      expect((error as GatewayError).param).toBe("model");
    }
  });
});

describe("API keys", () => {
  const originalPepper = process.env.NEXA_API_KEY_PEPPER;

  beforeEach(() => {
    delete process.env.NEXA_API_KEY_PEPPER;
  });

  afterEach(() => {
    if (originalPepper === undefined) delete process.env.NEXA_API_KEY_PEPPER;
    else process.env.NEXA_API_KEY_PEPPER = originalPepper;
  });

  it("generates a high-entropy, prefixed, unrecoverable key", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.plaintext.startsWith(NEXA_API_KEY_PREFIX)).toBe(true);
    expect(a.plaintext.length).toBeGreaterThanOrEqual(40);
    expect(isNexaApiKeyFormat(a.plaintext)).toBe(true);
    // Two keys must never collide.
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).toBe(hashApiKey(a.plaintext));
    // The stored form is a digest, not the secret.
    expect(a.hash).not.toContain(a.plaintext);
    expect(a.displayPrefix).not.toBe(a.plaintext);
  });

  it("changes the digest when the pepper changes", () => {
    process.env.NEXA_API_KEY_PEPPER = "pepper-one";
    const first = hashApiKey("nexa_sk_test");
    process.env.NEXA_API_KEY_PEPPER = "pepper-two";
    expect(hashApiKey("nexa_sk_test")).not.toBe(first);
  });

  // --- Phase 5.1: the pepper must not silently become a weak production secret ---

  it("refuses to hash in production when no pepper is configured", () => {
    // Before this guard, a missing pepper meant sha256("…::" + key): a
    // deterministic, unkeyed digest that a database dump could be used to test
    // candidate keys against offline. Failing loudly is safer than running in a
    // weaker mode than the operator believes they are in.
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.NEXA_API_KEY_PEPPER;
    expect(() => hashApiKey("nexa_sk_test")).toThrow(/NEXA_API_KEY_PEPPER/);
  });

  it("treats a whitespace-only pepper as absent", () => {
    // A pepper that is present but blank must not slip past the guard.
    vi.stubEnv("NODE_ENV", "production");
    process.env.NEXA_API_KEY_PEPPER = "   ";
    expect(() => hashApiKey("nexa_sk_test")).toThrow(/NEXA_API_KEY_PEPPER/);
  });

  it("names the variable in the failure but never echoes a value", () => {
    // The error must be actionable for an operator without becoming a channel
    // that prints a secret into a log or an HTTP body.
    vi.stubEnv("NODE_ENV", "production");
    process.env.NEXA_API_KEY_PEPPER = "";
    let message = "";
    try {
      hashApiKey("nexa_sk_test");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/NEXA_API_KEY_PEPPER/);
    expect(message).toMatch(/openssl rand -hex 32/);
    expect(message).not.toMatch(/nexa_sk_test/);
  });

  it("hashes normally in production once a pepper is configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.NEXA_API_KEY_PEPPER = "a-real-operator-set-pepper";
    expect(() => hashApiKey("nexa_sk_test")).not.toThrow();
  });

  it("tolerates a missing pepper in development so a fresh clone still runs", () => {
    // Throwing unconditionally would make the app unusable before an operator
    // has ever created a .env file.
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.NEXA_API_KEY_PEPPER;
    expect(() => hashApiKey("nexa_sk_test")).not.toThrow();
  });

  it("only accepts a bearer token, never a bare token or another scheme", () => {
    expect(extractBearerToken("Bearer nexa_sk_abc")).toBe("nexa_sk_abc");
    expect(extractBearerToken("bearer nexa_sk_abc")).toBe("nexa_sk_abc");
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(extractBearerToken("nexa_sk_abc")).toBeNull();
    expect(extractBearerToken("Bearer   ")).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
  });
});
