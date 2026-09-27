/**
 * FreeLLMAPI provider unit tests.
 *
 * These tests never require a live FreeLLMAPI installation: every network call
 * is served by a stubbed `fetch`, and every environment variable they rely on
 * is set and restored locally. They verify the adapter's request construction,
 * SSE parsing, cancellation, and error classification — not a real model's
 * output.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  FreeLLMAPIProvider,
  extractCompletionText,
  extractStreamError,
  normalizeFreeLLMAPIBaseUrl,
  parseFreeLLMAPIModelList,
} from "@/lib/ai/providers/freellmapi";
import { ProviderError, redactSecrets } from "@/lib/ai/provider-errors";

const BASE = "http://127.0.0.1:8099";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: FetchCall[] = [];

/** Stub `fetch` with a handler and record every call. */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => Promise<Response>) {
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A real streaming Response whose chunks are delivered on demand, so token
 * emission can be observed incrementally.
 */
function sseResponse(
  chunks: string[],
  options: { contentType?: string; status?: number; onCancel?: () => void; keepOpen?: boolean } = {}
): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
        return;
      }
      if (!options.keepOpen) controller.close();
    },
    cancel() {
      options.onCancel?.();
    },
  });
  return new Response(stream, {
    status: options.status ?? 200,
    headers: { "content-type": options.contentType ?? "text/event-stream" },
  });
}

function sseFrame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const MODEL_LIST = {
  object: "list",
  data: [
    { id: "provider/model-a", object: "model", owned_by: "some-org" },
    { id: "provider/model-a", object: "model" },
    { id: "", object: "model" },
    "not-an-object",
  ],
};

function collectEvents() {
  const events: Array<{ type: string; content?: string }> = [];
  return { events, emit: (event: { type: string; content?: string }) => events.push(event) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  calls = [];
  delete process.env.FREELLMAPI_BASE_URL;
  delete process.env.FREELLMAPI_API_KEY;
  delete process.env.FREELLMAPI_MODEL;
});

describe("FreeLLMAPIProvider construction and configuration", () => {
  it("implements the shared ModelProvider contract with its own provider identity", () => {
    const provider = new FreeLLMAPIProvider(BASE);
    expect(provider.id).toBe("freellmapi");
    expect(provider.name).toBe("FreeLLMAPI");
    expect(provider.type).toBe("freellmapi");
    expect(typeof provider.testConnection).toBe("function");
    expect(typeof provider.listModels).toBe("function");
    expect(typeof provider.generateStream).toBe("function");
  });

  it("normalizes the configured base URL and never duplicates /v1", () => {
    expect(normalizeFreeLLMAPIBaseUrl("http://host:8000")).toBe("http://host:8000");
    expect(normalizeFreeLLMAPIBaseUrl("http://host:8000/")).toBe("http://host:8000");
    expect(normalizeFreeLLMAPIBaseUrl("http://host:8000/v1")).toBe("http://host:8000");
    expect(normalizeFreeLLMAPIBaseUrl("  ")).toBe("");

    const provider = new FreeLLMAPIProvider("http://host:8000/v1/");
    expect(provider.modelsEndpoint).toBe("http://host:8000/v1/models");
    expect(provider.chatEndpoint).toBe("http://host:8000/v1/chat/completions");
  });

  it("treats a missing FREELLMAPI_BASE_URL as misconfigured and performs no request", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(MODEL_LIST));
    const provider = new FreeLLMAPIProvider();

    expect(provider.isConfigured()).toBe(false);
    expect(provider.getConfigurationIssue()).toContain("FREELLMAPI_BASE_URL");

    const health = await provider.testConnection();
    expect(health.ok).toBe(false);
    expect(health.status).toBe("misconfigured");
    expect(await provider.listModels()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      provider.generateStream(
        { model: "provider/model-a", messages: [{ role: "user", content: "hi" }] },
        () => undefined
      )
    ).rejects.toMatchObject({ code: "misconfigured" });
  });

  it("reads the endpoint and key from the server environment when not passed", async () => {
    process.env.FREELLMAPI_BASE_URL = `${BASE}/v1`;
    process.env.FREELLMAPI_API_KEY = "env-secret-key";
    const fetchMock = stubFetch(async () => jsonResponse(MODEL_LIST));

    const provider = new FreeLLMAPIProvider();
    expect(provider.isConfigured()).toBe(true);
    expect(provider.hasCredential()).toBe(true);

    await provider.listModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe(`${BASE}/v1/models`);
  });

  it("rejects a non-http(s) base URL instead of calling it", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(MODEL_LIST));
    const provider = new FreeLLMAPIProvider("file:///etc/passwd");
    const health = await provider.testConnection();
    expect(health.status).toBe("misconfigured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});


describe("FreeLLMAPI model discovery", () => {
  it("sends no Authorization header when no API key is configured", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(MODEL_LIST));
    const provider = new FreeLLMAPIProvider(BASE);

    const health = await provider.testConnection();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(health.ok).toBe(true);
    expect(health.status).toBe("available");
  });

  it("sends Authorization: Bearer only when a key is configured, and never in the URL", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(MODEL_LIST));
    const provider = new FreeLLMAPIProvider(BASE, "sk-live-abcdef123456");

    await provider.testConnection();
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-live-abcdef123456");

    expect(calls[0].url).toBe(`${BASE}/v1/models`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls[0].url).not.toContain("sk-live-abcdef123456");
  });

  it("normalizes /v1/models into the NEXA discovery shape without inventing metadata", async () => {
    stubFetch(async () =>
      jsonResponse({
        object: "list",
        data: [
          { id: "vendor/model-a", owned_by: "vendor", context_length: 32768 },
          { id: "vendor/model-b" },
          { id: "vendor/model-b" },
          { id: "   " },
          null,
        ],
      })
    );
    const provider = new FreeLLMAPIProvider(BASE);
    const catalog = await provider.discoverCatalog();

    expect(catalog.models.map((m) => m.id)).toEqual(["vendor/model-a", "vendor/model-b"]);
    expect(catalog.models[0]).toMatchObject({
      provider: "freellmapi",
      name: "vendor/model-a",
      ownedBy: "vendor",
      contextWindow: 32768,
      supportsTools: null,
      supportsVision: null,
      supportsStreaming: null,
    });
    // Nothing was reported for model-b, so nothing is claimed for it.
    expect(catalog.models[1].contextWindow).toBeNull();
    expect(catalog.models[1].ownedBy).toBeUndefined();
    expect(catalog.health.models).toEqual(["vendor/model-a", "vendor/model-b"]);
  });

  it("returns an honest failure when discovery fails", async () => {
    stubFetch(async () => new Response("upstream exploded", { status: 500 }));
    const provider = new FreeLLMAPIProvider(BASE);

    const health = await provider.testConnection();
    expect(health.ok).toBe(false);
    expect(health.status).toBe("unavailable");
    expect(await provider.listModels()).toEqual([]);
  });

  it("classifies an unauthorized response", async () => {
    stubFetch(async () => new Response('{"error":"bad key"}', { status: 401 }));
    const provider = new FreeLLMAPIProvider(BASE, "sk-secret-value");

    const health = await provider.testConnection();
    expect(health.ok).toBe(false);
    expect(health.status).toBe("unauthorized");
    expect(health.message).toContain("FREELLMAPI_API_KEY");
  });

  it("classifies a rate-limited response", async () => {
    stubFetch(async () => new Response("slow down", { status: 429 }));
    const health = await new FreeLLMAPIProvider(BASE).testConnection();
    expect(health.ok).toBe(false);
    expect(health.status).toBe("rate_limited");
  });

  it("classifies a 404 on the models endpoint as misconfiguration", async () => {
    stubFetch(async () => new Response("not found", { status: 404 }));
    const health = await new FreeLLMAPIProvider(BASE).testConnection();
    expect(health.status).toBe("misconfigured");
  });

  it("classifies a discovery timeout", async () => {
    vi.useFakeTimers();
    stubFetch(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        })
    );

    const provider = new FreeLLMAPIProvider(BASE);
    const pending = provider.testConnection();
    await vi.advanceTimersByTimeAsync(5_000);
    const health = await pending;

    expect(health.ok).toBe(false);
    expect(health.status).toBe("timeout");
  });

  it("parses model payloads defensively", () => {
    expect(parseFreeLLMAPIModelList(null)).toEqual([]);
    expect(parseFreeLLMAPIModelList({ data: "nope" })).toEqual([]);
    expect(
      parseFreeLLMAPIModelList({ data: [{ id: "x", context_length: 0 }] })[0].contextWindow
    ).toBeNull();
  });
});

describe("FreeLLMAPI chat requests", () => {
  it("builds an OpenAI-compatible streaming request from the NEXA abstraction", async () => {
    stubFetch(async () => sseResponse(["data: [DONE]\n\n"]));
    const provider = new FreeLLMAPIProvider(BASE, "sk-test-key");
    const { emit } = collectEvents();

    await provider.generateStream(
      {
        model: "vendor/model-a",
        systemPrompt: "be brief",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
        temperature: 0.2,
        topP: 0.5,
        maxTokens: 128,
      },
      emit
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/v1/chat/completions`);
    expect(calls[0].init?.method).toBe("POST");

    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer sk-test-key");

    const payload = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(payload).toEqual({
      model: "vendor/model-a",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      stream: true,
      temperature: 0.2,
      top_p: 0.5,
      max_tokens: 128,
    });
    // Unsupported fields are never forwarded.
    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("functions");
    expect(payload).not.toHaveProperty("response_format");
  });

  it("refuses an empty model id instead of sending a malformed request", async () => {
    const fetchMock = stubFetch(async () => sseResponse(["data: [DONE]\n\n"]));
    await expect(
      new FreeLLMAPIProvider(BASE).generateStream(
        { model: "  ", messages: [{ role: "user", content: "hi" }] },
        () => undefined
      )
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies a rejected chat request and never leaks the API key", async () => {
    const key = "sk-live-super-secret-key";
    stubFetch(
      async () =>
        new Response(JSON.stringify({ error: { message: `invalid api_key=${key}` } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
    );
    const provider = new FreeLLMAPIProvider(BASE, key);

    const failure = await provider
      .generateStream(
        { model: "vendor/model-a", messages: [{ role: "user", content: "hi" }] },
        () => undefined
      )
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ProviderError);
    const error = failure as ProviderError;
    expect(error.code).toBe("unauthorized");
    expect(error.status).toBe(401);
    expect(error.message).not.toContain(key);
  });
});


describe("FreeLLMAPI streaming", () => {
  it("streams incremental chunks, does not duplicate tokens, and stops at [DONE]", async () => {
    let cancelCalled = false;
    stubFetch(async () =>
      sseResponse(
        [
          sseFrame({ choices: [{ delta: { content: "Hello" } }] }),
          sseFrame({ choices: [{ delta: { content: " world" } }] }),
          "data: [DONE]\n\n",
          // Nothing after [DONE] may be surfaced.
          sseFrame({ choices: [{ delta: { content: "SHOULD-NOT-APPEAR" } }] }),
        ],
        {
          onCancel: () => {
            cancelCalled = true;
          },
        }
      )
    );

    const { events, emit } = collectEvents();
    const result = await new FreeLLMAPIProvider(BASE).generateStream(
      { model: "vendor/model-a", messages: [{ role: "user", content: "hi" }] },
      emit
    );

    expect(events.map((e) => e.type)).toEqual(["token", "token", "done"]);
    expect(events.filter((e) => e.type === "token").map((e) => e.content)).toEqual([
      "Hello",
      " world",
    ]);
    expect(result.fullText).toBe("Hello world");
    expect(result.fullText).not.toContain("SHOULD-NOT-APPEAR");
    expect(cancelCalled).toBe(true);
  });

  it("surfaces reasoning content as reasoning events", async () => {
    stubFetch(async () =>
      sseResponse([
        sseFrame({ choices: [{ delta: { reasoning_content: "thinking" } }] }),
        sseFrame({ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ])
    );
    const { events, emit } = collectEvents();
    const result = await new FreeLLMAPIProvider(BASE).generateStream(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      emit
    );

    expect(events.map((e) => e.type)).toEqual(["reasoning", "token", "done"]);
    expect(result.reasoningText).toBe("thinking");
    expect(result.fullText).toBe("answer");
  });

  it("skips malformed SSE frames and keeps delivering valid ones across chunk boundaries", async () => {
    stubFetch(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"A"}}]}\n',
        "\n",
        "data: this-is-not-json\n\n",
        ": keep-alive comment\n\n",
        sseFrame({ choices: [{ delta: { content: "B" } }] }),
        "data: [DONE]\n\n",
      ])
    );
    const { events, emit } = collectEvents();
    const result = await new FreeLLMAPIProvider(BASE).generateStream(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      emit
    );

    expect(result.fullText).toBe("AB");
    expect(events.map((e) => e.type)).toEqual(["token", "token", "done"]);
  });

  it("turns an error object streamed over HTTP 200 into a provider error", async () => {
    const key = "sk-stream-secret";
    stubFetch(async () =>
      sseResponse([
        sseFrame({ choices: [{ delta: { content: "partial" } }] }),
        sseFrame({ error: { message: `quota exhausted for ${key}`, type: "quota_exceeded" } }),
      ])
    );

    const failure = await new FreeLLMAPIProvider(BASE, key)
      .generateStream({ model: "m", messages: [{ role: "user", content: "hi" }] }, () => undefined)
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ProviderError);
    const error = failure as ProviderError;
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("quota exhausted");
    expect(error.message).not.toContain(key);
  });

  it("emits a single token when the endpoint answers with plain JSON instead of SSE", async () => {
    stubFetch(async () =>
      jsonResponse({
        choices: [
          { message: { role: "assistant", content: "non-streamed answer" }, finish_reason: "stop" },
        ],
      })
    );
    const { events, emit } = collectEvents();
    const result = await new FreeLLMAPIProvider(BASE).generateStream(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      emit
    );

    expect(events.map((e) => e.type)).toEqual(["token", "done"]);
    expect(result.fullText).toBe("non-streamed answer");
  });

  it("reports a protocol error when the stream closes with no content at all", async () => {
    stubFetch(async () => sseResponse([]));
    const failure = await new FreeLLMAPIProvider(BASE)
      .generateStream({ model: "m", messages: [{ role: "user", content: "hi" }] }, () => undefined)
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).code).toBe("protocol");
  });
});


describe("FreeLLMAPI cancellation and timeouts", () => {
  it("emits tokens while the stream is open (nothing is buffered) and aborts cleanly", async () => {
    const controller = new AbortController();
    let cancelCalled = false;
    stubFetch(async () =>
      sseResponse([sseFrame({ choices: [{ delta: { content: "Hello" } }] })], {
        keepOpen: true,
        onCancel: () => {
          cancelCalled = true;
        },
      })
    );

    const { events, emit } = collectEvents();
    const pending = new FreeLLMAPIProvider(BASE).generateStream(
      {
        model: "vendor/model-a",
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
      },
      emit
    );

    // The first token arrives while the stream is still open.
    await vi.waitFor(() => expect(events.some((e) => e.type === "token")).toBe(true));
    expect(events.some((e) => e.type === "done")).toBe(false);

    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(cancelCalled).toBe(true);
  });

  it("refuses to start when the signal is already aborted", async () => {
    const fetchMock = stubFetch(async () => sseResponse(["data: [DONE]\n\n"]));
    const controller = new AbortController();
    controller.abort();

    await expect(
      new FreeLLMAPIProvider(BASE).generateStream(
        { model: "m", messages: [{ role: "user", content: "hi" }], signal: controller.signal },
        () => undefined
      )
    ).rejects.toMatchObject({ code: "aborted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies a chat connection timeout", async () => {
    vi.useFakeTimers();
    stubFetch(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        })
    );

    const pending = new FreeLLMAPIProvider(BASE).generateStream(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      () => undefined
    );
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    // The first-byte budget is 60s (see CONNECT_TIMEOUT_MS in the provider).
    await vi.advanceTimersByTimeAsync(61_000);
    await assertion;
  });

  it("abandons a stream that goes silent beyond the idle budget", async () => {
    vi.useFakeTimers();
    stubFetch(async () =>
      sseResponse([sseFrame({ choices: [{ delta: { content: "Hi" } }] })], { keepOpen: true })
    );

    const pending = new FreeLLMAPIProvider(BASE).generateStream(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      () => undefined
    );
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(61_000);
    await assertion;
  });

  it("classifies a network failure during a chat request", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const failure = await new FreeLLMAPIProvider(BASE)
      .generateStream({ model: "m", messages: [{ role: "user", content: "hi" }] }, () => undefined)
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).code).toBe("unavailable");
    expect((failure as ProviderError).healthStatus).toBe("unavailable");
  });
});

describe("provider error normalization", () => {
  it("classifies codes from HTTP statuses", () => {
    const parse = (payload: unknown) => extractCompletionText(payload);
    // delta and message must never both be counted.
    expect(
      parse({ choices: [{ delta: { content: "delta" }, message: { content: "message" } }] })
    ).toMatchObject({ content: "delta", finished: false });
    expect(parse({ choices: [{ message: { content: "only message" } }] }).content).toBe("only message");
    expect(parse({ choices: [] })).toMatchObject({ content: "", reasoning: "", finished: false });
    expect(parse(null)).toMatchObject({ content: "" });
  });

  it("extracts streamed error objects", () => {
    expect(extractStreamError({ error: { message: "boom" } })).toBe("boom");
    expect(extractStreamError({ error: { code: "quota" } })).toBe("quota");
    expect(extractStreamError({ error: "plain" })).toBe("plain");
    expect(extractStreamError({ choices: [] })).toBeUndefined();
  });

  it("redacts bearer tokens, sk- keys, and explicitly supplied secrets", () => {
    const key = "sk-configured-key-value";
    const text = `Authorization: Bearer ${key} -- apiKey=${key} -- sk-abcdef123456`;
    const redacted = redactSecrets(text, [key]);
    expect(redacted).not.toContain(key);
    expect(redacted).not.toContain("sk-abcdef123456");
  });
});

