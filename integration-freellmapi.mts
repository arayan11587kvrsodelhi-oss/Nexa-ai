/**
 * FreeLLMAPI adapter — deterministic contract test (Phase 2).
 *
 * The external FreeLLMAPI installation is not running in this environment, so
 * this proves the **adapter contract** against a real local HTTP server that
 * speaks the exact protocol the adapter expects:
 *
 *   GET  {base}/v1/models
 *   POST {base}/v1/chat/completions      (OpenAI-compatible, SSE)
 *   Authorization: Bearer <key>          (only when a key is configured)
 *
 * Everything above the socket is the real code path: ExternalFreeLLMAPIProvider
 * → FreeLLMAPIProvider → real fetch → real SSE parsing → gateway ChatChunks.
 * Only the far end is deterministic, which is what makes the cases
 * reproducible. This is a *contract* test, not a live-installation test.
 */
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

process.env.NEXA_PROVIDER_ORDER = "freellmapi";
delete process.env.OLLAMA_BASE_URL;
delete process.env.AI_HORDE_ENABLED;
delete process.env.OPENAI_COMPATIBLE_BASE_URL;

const results: string[] = [];
const check = (name: string, pass: boolean, detail = ""): void => {
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
let handler: Handler = (_req, res) => {
  res.writeHead(500).end("{}");
};

const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    void Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500).end("{}");
    });
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.FREELLMAPI_BASE_URL = `${BASE}/v1`;

const { FreeLLMAPIProvider, extractCompletionText } = await import(
  "./src/lib/ai/providers/freellmapi.ts"
);
const { ExternalFreeLLMAPIProvider } = await import(
  "./src/lib/gateway/providers/external-freellmapi.ts"
);
const { GatewayError } = await import("./src/lib/gateway/errors.ts");

const KEY = "sk-test-contract-key";
const provider = new ExternalFreeLLMAPIProvider(`${BASE}/v1`, KEY);
const json = (res: ServerResponse, status: number, payload: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
};
const MODEL_LIST = {
  object: "list",
  data: [
    { id: "koboldcpp/Angelic_Eclipse-12B", object: "model", owned_by: "koboldcpp", context_length: 8192 },
    { id: "vendor/model-a", object: "model" },
    { id: "", object: "model" },
    "not-an-object",
    { id: "vendor/model-a", object: "model" },
  ],
};
const REQ = { model: "vendor/model-a", messages: [{ role: "user", content: "hi" }], stream: true };

async function collect(p: { streamChat: (r: unknown) => AsyncIterable<any> }, request = REQ) {
  const events: any[] = [];
  // A mid-stream upstream failure legitimately throws from the async iterator:
  // that is how the gateway's commit point learns the stream broke. Record it
  // as a terminal observation instead of aborting the whole run.
  try {
    for await (const chunk of p.streamChat(request)) events.push(chunk);
  } catch (error) {
    events.push({ type: "threw", error });
  }
  return events;
}

/** The freeapi adapter caches its discovery for 30s, so each group gets a fresh one. */
const freshProvider = () => new ExternalFreeLLMAPIProvider(`${BASE}/v1`, KEY);
const tokenText = (events: any[]) =>
  events.filter((e) => e.type === "token").map((e) => e.content).join("");

function sseWrite(
  res: ServerResponse,
  frames: string[],
  opts: { split?: boolean; crlf?: boolean } = {}
) {
  const eol = opts.crlf ? "\r\n" : "\n";
  res.writeHead(200, { "content-type": "text/event-stream" });
  let i = 0;
  const step = () => {
    if (res.writableEnded) return;
    if (i >= frames.length) {
      res.write(`data: [DONE]${eol}${eol}`);
      res.end();
      return;
    }
    const frame = frames[i++].replace(/\n/g, eol);
    if (opts.split) {
      // Break the frame mid-JSON across two TCP writes — the historical bug.
      const cut = Math.max(1, Math.floor(frame.length / 2));
      res.write(frame.slice(0, cut));
      setTimeout(step, 5);
      res.write(frame.slice(cut));
    } else {
      res.write(frame);
    }
    setTimeout(step, 5);
  };
  step();
}
const deltaFrame = (payload: object) => `data: ${JSON.stringify(payload)}\n\n`;
const framesFor = (parts: string[]) =>
  parts.map((p) => deltaFrame({ choices: [{ delta: { content: p } }] }));

console.log("=".repeat(72));
console.log("FREELLMAPI ADAPTER CONTRACT TEST (deterministic local server)");
console.log("=".repeat(72));

// ------------------------------------------------- A. model discovery
{
  handler = (_req, res) => json(res, 200, MODEL_LIST);
  const models = await freshProvider().listModels();
  check("A1 valid catalog parsed", models.length === 2, `got ${models.length}`);
  check("A2 provider/model identifier preserved", models[0]?.id === "koboldcpp/Angelic_Eclipse-12B");
  check(
    "A3 reported context length kept, never invented",
    models[0]?.contextLength === 8192 && models[1]?.contextLength === null,
    `${models[0]?.contextLength}/${models[1]?.contextLength}`
  );
  check(
    "A4 capabilities stay null (never inferred from a name)",
    models.every((m: any) => m.capabilities.tools === null && m.capabilities.vision === null)
  );
  check("A5 duplicate and empty ids dropped", !models.some((m: any) => m.id === ""));

  handler = (_req, res) => json(res, 200, { object: "list", data: [] });
  check("A6 empty catalog → empty list, no throw", (await freshProvider().listModels()).length === 0);

  handler = (_req, res) => json(res, 200, { data: "nope" });
  check("A7 malformed catalog → empty list, no throw", (await freshProvider().listModels()).length === 0);

  handler = (_req, res) => json(res, 200, null);
  check("A8 null catalog → empty list, no throw", (await freshProvider().listModels()).length === 0);

  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{not json");
  };
  check("A9 malformed JSON body → empty list, no throw", (await freshProvider().listModels()).length === 0);
}

// ------------------------------------------------- B. health
{
  handler = (_req, res) => json(res, 200, MODEL_LIST);
  const fresh = freshProvider;

  let health = await fresh().health({} as any);
  check("B1 healthy provider reports ok", health.ok === true, health.status);
  check("B2 healthy provider reports its model count", (health.models?.length ?? 0) === 2);

  handler = (_req, res) => res.destroy();
  health = await fresh().health({} as any);
  check("B3 unreachable provider → not ok", health.ok === false, health.status);

  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("<<<not json>>>");
  };
  health = await fresh().health({} as any);
  check("B4 malformed JSON → not ok, no throw", health.ok === false);

  for (const [status, expected] of [
    [401, "authentication_error"],
    [429, "rate_limited"],
    [500, "unavailable"],
  ] as const) {
    handler = (_req, res) => json(res, status, { error: { message: "nope" } });
    health = await fresh().health({} as any);
    check(`B5 HTTP ${status} → ${expected}`, health.status === expected, `got ${health.status}`);
  }

  handler = async (_req, res) => {
    await delay(1500);
    if (!res.writableEnded) json(res, 200, MODEL_LIST);
  };
  const started = Date.now();
  const hung = await Promise.race([fresh().health({} as any), delay(4000).then(() => null)]);
  check(
    "B6 a hung upstream does not hang health indefinitely",
    hung === null || Date.now() - started < 4000,
    `resolved in ${Date.now() - started}ms`
  );
}

// ------------------------------------------------- C. streaming
{
  const deltas = ["Hello", " world", "!"];
  handler = (_req, res) => sseWrite(res, framesFor(deltas));
  let events = await collect(freshProvider());
  check("C1 LF stream → correct normalized text", tokenText(events) === "Hello world!", JSON.stringify(tokenText(events)));
  check("C2 emits a done frame", events.some((e) => e.type === "done"));
  check("C3 no error frame", !events.some((e) => e.type === "error"));

  handler = (_req, res) => sseWrite(res, framesFor(deltas), { crlf: true });
  events = await collect(freshProvider());
  check("C4 CRLF stream → same normalized text", tokenText(events) === "Hello world!", JSON.stringify(tokenText(events)));

  handler = (_req, res) => sseWrite(res, framesFor(deltas), { split: true });
  events = await collect(freshProvider());
  check("C5 frames split mid-JSON → reassembled once", tokenText(events) === "Hello world!", JSON.stringify(tokenText(events)));

  handler = (_req, res) =>
    sseWrite(res, [
      deltaFrame({ choices: [{ delta: { reasoning_content: "thinking 🌍" } }] }),
      deltaFrame({ choices: [{ delta: { content: "" } }] }),
      deltaFrame({ choices: [{ delta: { content: "你好 café" } }] }),
    ]);
  events = await collect(freshProvider());
  const reasoning = events.filter((e) => e.type === "reasoning").map((e) => e.content).join("");
  check("C6 Unicode survives", tokenText(events).includes("你好 café"), JSON.stringify(tokenText(events)));
  check("C7 reasoning normalized separately", reasoning.includes("thinking 🌍"), JSON.stringify(reasoning));
  check("C8 empty token produces no token event", events.filter((e) => e.type === "token").length === 1);

  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(deltaFrame({ choices: [{ delta: { content: "partial" } }] }));
    res.write(deltaFrame({ error: { message: "upstream died" } }));
    res.write("data: [DONE]\n\n");
    res.end();
  };
  events = await collect(freshProvider());
  check(
    "C9 in-stream error after a token surfaces as a classified error",
    events.some((e) => e.type === "threw" && e.error instanceof GatewayError),
    JSON.stringify(events.map((e) => e.type))
  );

  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": keep-alive\n\ndata: [DONE]\n\n");
    res.end();
  };
  events = await collect(freshProvider());
  check("C10 a content-free stream produces no token events", !events.some((e) => e.type === "token"));
}

// ------------------------------------------------- D. snapshot / cumulative
{
  handler = (_req, res) => sseWrite(res, framesFor(["Hello", "Hello world", "Hello world!"]));
  const events = await collect(freshProvider());
  const tokens = events.filter((e) => e.type === "token").map((e) => e.content);
  check("D1 cumulative frames deliver each character exactly once", tokens.join("") === "Hello world!", JSON.stringify(tokens));
  check("D2 no snapshot re-sent whole", !tokens.includes("Hello world"), JSON.stringify(tokens));
  const done = events.find((e) => e.type === "done");
  check("D3 done.content matches what the client received", done?.data?.content === "Hello world!", JSON.stringify(done?.data?.content));
  check(
    "D4 non-streaming completion extracted",
    extractCompletionText({ choices: [{ message: { content: "Hello world!" } }] }).content ===
      "Hello world!"
  );
}

// ------------------------------------------------- E. provider failure
{
  handler = (_req, res) => json(res, 500, { error: { message: "boom" } });
  let events = await collect(freshProvider());
  const err = events.find((e) => e.type === "error" || e.type === "threw");
  check("E1 pre-token failure → error, no tokens", Boolean(err) && !events.some((e) => e.type === "token"), JSON.stringify(events.map((e) => e.type)));
  check("E2 failure carries a classified gateway error", err?.error instanceof GatewayError || err?.data instanceof GatewayError, err?.error?.category ?? err?.data?.category);
  check("E3 upstream error text does not leak the credential", !JSON.stringify(events).includes(KEY));

  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(deltaFrame({ choices: [{ delta: { content: "Hello" } }] }));
    res.destroy();
  };
  // E4: the upstream sends a frame, then the socket dies. Tokens already
  // handed to the consumer must not be retracted, and the failure must still
  // be reported.
  let emitted: string[] = [];
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(deltaFrame({ choices: [{ delta: { content: "Hello" } }] }));
    // Give the frame time to reach the client before killing the socket.
    setTimeout(() => res.destroy(), 120);
  };
  try {
    for await (const chunk of freshProvider().streamChat(REQ)) {
      if (chunk.type === "token") emitted.push(chunk.content);
    }
  } catch {
    // The committed token is what matters here.
  }
  check("E4 post-token failure keeps the committed token", emitted.join("") === "Hello", JSON.stringify(emitted));

  // E5: the same failure must still be reported rather than swallowed.
  events = await collect(freshProvider());
  check(
    "E5 post-token failure is surfaced",
    events.some((e) => e.type === "error" || e.type === "threw"),
    JSON.stringify(events.map((e) => e.type))
  );
}

// ------------------------------------------------- F. auth header
{
  let seenAuth: string | undefined;
  handler = (req, res) => {
    seenAuth = req.headers.authorization;
    json(res, 200, MODEL_LIST);
  };
  await new FreeLLMAPIProvider(`${BASE}/v1`, KEY).discoverCatalog();
  check("F1 Authorization: Bearer sent when a key is configured", seenAuth === `Bearer ${KEY}`);

  // F2 needs the env fallback cleared too: the constructor falls back to
  // FREELLMAPI_API_KEY, which is set in this environment.
  const savedKey = process.env.FREELLMAPI_API_KEY;
  delete process.env.FREELLMAPI_API_KEY;
  seenAuth = undefined;
  try {
    await new FreeLLMAPIProvider(`${BASE}/v1`, undefined).discoverCatalog();
  } finally {
    if (savedKey !== undefined) process.env.FREELLMAPI_API_KEY = savedKey;
  }
  check("F2 no Authorization header when no key is configured", seenAuth === undefined, String(seenAuth));
}

server.close();
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log("\n" + "=".repeat(72));
console.log(`${results.length - failed.length}/${results.length} contract checks passed`);
if (failed.length) console.log("FAILED:\n" + failed.join("\n"));
console.log("=".repeat(72));
process.exit(failed.length ? 1 : 0);
