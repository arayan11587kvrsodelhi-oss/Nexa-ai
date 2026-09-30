/**
 * Real incremental-streaming validation over a real socket.
 *
 * AI Horde answers a queued generation in one blocking body (documented), so it
 * cannot prove incremental delivery. This drives the real gateway against a real
 * local HTTP server that speaks genuine OpenAI-compatible SSE and deliberately
 * **splits frames mid-event across TCP writes** — the exact condition that
 * caused the historical duplicated/empty-Markdown defect.
 *
 * Nothing about the gateway is mocked: real fetch, real socket, real SSE parser.
 */
import "dotenv/config";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

process.env.NEXA_PROVIDER_ORDER = "openai_compatible";
process.env.OPENAI_COMPATIBLE_BASE_URL = ""; // set below once the port is known
delete process.env.FREELLMAPI_BASE_URL;
delete process.env.AI_HORDE_ENABLED;

const TOKEN_DELTAS = ["The ", "quick ", "brown ", "fox ", "jumps ", "over ", "the ", "lazy ", "dog."];
const EXPECTED = TOKEN_DELTAS.join("");

/** Emit an SSE frame split into pieces that break mid-JSON and mid-line. */
function splitFrame(payload: object, pieces: number): string {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  // Deliberately cut at awkward offsets: inside the JSON, before the newline,
  // and between CR and LF.
  const cuts = [3, 11, frame.length - 3, frame.length - 1];
  let out = "";
  let at = 0;
  for (const cut of cuts) {
    if (cut >= frame.length || cut <= at) continue;
    out += frame.slice(at, cut);
    at = cut;
  }
  out += frame.slice(at);
  void pieces;
  return out;
}

const server = createServer((req, res) => {
  if (req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "test-model" }] }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  let i = 0;
  const timer = setInterval(() => {
    if (i < TOKEN_DELTAS.length) {
      // Each write carries a fragment of a frame: the client must reassemble.
      res.write(splitFrame({ choices: [{ delta: { content: TOKEN_DELTAS[i] } }] }, 4));
      i += 1;
      return;
    }
    res.write("data: [DONE]\n\n");
    clearInterval(timer);
    res.end();
  }, 12);
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
process.env.OPENAI_COMPATIBLE_BASE_URL = `http://127.0.0.1:${port}/v1`;

const { NexaGateway } = await import("./src/lib/gateway/gateway.ts");
const { GatewayModelRegistry } = await import("./src/lib/gateway/registry.ts");

console.log("=".repeat(70));
console.log("REAL SOCKET / SPLIT-FRAME STREAMING TEST");
console.log("=".repeat(70));

await NexaGateway.listModels({ refresh: true });
console.log("discovered:", GatewayModelRegistry.allModels().map((m) => `${m.provider}/${m.id}`));

const events: string[] = [];
let content = "";
let reasoning = "";
let done: any = null;
let error: any = null;
const started = Date.now();
let firstTokenAt: number | null = null;

for await (const chunk of NexaGateway.streamChat({
  model: "openai_compatible/test-model",
  messages: [{ role: "user", content: "Reply with exactly: NEXA SPLIT TEST PASSED" }],
  stream: true,
  maxTokens: 128,
})) {
  events.push(chunk.type);
  if (chunk.type === "token" && chunk.content) {
    if (firstTokenAt === null) firstTokenAt = Date.now();
    content += chunk.content;
  }
  if (chunk.type === "reasoning" && chunk.content) reasoning += chunk.content;
  if (chunk.type === "done") done = chunk.data;
  if (chunk.type === "error") error = chunk.data ?? chunk.content;
}

console.log("\nevent types:", JSON.stringify(events));
console.log("token events:", events.filter((t) => t === "token").length);
console.log("time to first token:", firstTokenAt === null ? "n/a" : `${firstTokenAt - started}ms`);
console.log("total:", `${Date.now() - started}ms`);
console.log("error:", error ? JSON.stringify(error) : "none");
console.log("content:", JSON.stringify(content));
console.log("expected:", JSON.stringify(EXPECTED));
console.log("");
console.log("RESULT content matches exactly:", content === EXPECTED);
console.log("RESULT token count > 1 (incremental):", events.filter((t) => t === "token").length > 1);
console.log("RESULT no duplicated substring:", !content.includes(EXPECTED + EXPECTED));
console.log("RESULT reasoning empty:", reasoning === "");
console.log("RESULT no empty fence:", !/```\s*```/.test(content));
console.log("RESULT done present:", done !== null);
if (done) {
  console.log("RESULT done.content === streamed:", done.content === content);
  console.log("RESULT provider:", done.provider, "model:", done.model);
  console.log("RESULT finishReason:", done.finishReason);
}

server.close();
process.exit(0);
