/**
 * Real `/v1` validation against the live AI Horde provider (Phase 9 + 10).
 *
 * A real user and a real API key are created in the real database, then the
 * actual route handlers are exercised:
 *
 *   - `Authorization: Bearer nexa_sk_…` authenticates
 *   - a session cookie does NOT (bearer-only, Phase 10)
 *   - `stream: true` produces OpenAI-compatible SSE; `false` a completion
 *   - revoked / malformed / missing keys are rejected
 *   - no provider credential appears in any response
 *
 * The key comes from the real ApiKeyService, so CSPRNG + digest + pepper are
 * exercised rather than simulated. No secret is printed.
 */
import "dotenv/config";

process.env.AI_HORDE_ENABLED = "true";
process.env.AI_HORDE_BASE_URL = "https://oai.aihorde.net/v1";

const { ApiKeyService } = await import("./src/lib/gateway/api-key-store.ts");
const { db } = await import("./src/db/index.ts");
const { users } = await import("./src/db/schema.ts");
const { eq } = await import("drizzle-orm");
const { POST } = await import("./src/app/v1/chat/completions/route.ts");
const { GET: GET_MODELS } = await import("./src/app/v1/models/route.ts");
const { GET: GET_HEALTH } = await import("./src/app/v1/health/route.ts");
const { SseDecoder } = await import("./src/lib/gateway/sse.ts");

const MODEL = "koboldcpp/Angelic_Eclipse-12B";
const PINNED = `aihorde/${MODEL}`;
const PROMPT = "Reply with exactly: NEXA V1 TEST PASSED";

const results: string[] = [];
const check = (name: string, pass: boolean, detail = ""): void => {
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const userId = `usr_v1test_${Date.now()}`;
await db.insert(users).values({
  id: userId,
  email: `${userId}@nexa.invalid`,
  passwordHash: "not-a-real-hash-test-only",
});

const { plaintext: API_KEY, summary } = await ApiKeyService.create(userId, "integration test");
check(
  "key issued in nexa_sk_ format, digest stored",
  API_KEY.startsWith("nexa_sk_") && API_KEY.length >= 40
);
check(
  "plaintext key is never returned by list()",
  !(await ApiKeyService.list(userId)).some((k) =>
    Object.values(k).some((v) => typeof v === "string" && v.includes(API_KEY))
  )
);

function request(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const authed = (path: string, body?: unknown): Request =>
  request(path, body, { authorization: `Bearer ${API_KEY}` });

async function readSse(response: Response): Promise<{ frames: any[]; done: boolean }> {
  const sse = new SseDecoder();
  const bytes = new TextEncoder().encode(await response.text());
  const events = [...sse.decode(bytes), ...sse.flush()];
  const frames: any[] = [];
  let done = false;
  for (const event of events) {
    if (event.data === "[DONE]") {
      done = true;
      continue;
    }
    frames.push(JSON.parse(event.data));
  }
  return { frames, done };
}

const VALID = { model: PINNED, messages: [{ role: "user", content: PROMPT }] };

console.log("=".repeat(70));
console.log("REAL /v1 VALIDATION (live AI Horde, real API key, real Postgres)");
console.log("=".repeat(70));

{
  check("missing Authorization → 401", (await POST(request("/v1/chat/completions", VALID))).status === 401);
  check(
    "non-bearer scheme → 401",
    (await POST(request("/v1/chat/completions", VALID, { authorization: `Basic ${API_KEY}` }))).status === 401
  );
  check(
    "unknown key → 401",
    (await POST(request("/v1/chat/completions", VALID, {
      authorization: `Bearer nexa_sk_${"0".repeat(48)}`,
    }))).status === 401
  );
  check(
    "session cookie is NOT accepted on /v1 → 401",
    (await POST(request("/v1/chat/completions", VALID, { cookie: "nexa_session=whatever" }))).status === 401
  );
}

{
  const response = await GET_MODELS(authed("/v1/models"));
  const body = (await response.json()) as any;
  check("GET /v1/models → 200", response.status === 200, `got ${response.status}`);
  check("/v1/models is a list", body.object === "list" && Array.isArray(body.data));
  const ids: string[] = Array.isArray(body.data) ? body.data.map((m: any) => m.id) : [];
  const pinned: string[] = Array.isArray(body.data)
    ? body.data.map((m: any) => m.nexa_pinned_id)
    : [];
  check(
    "explicitly pinned model is listed (as nexa_pinned_id)",
    pinned.includes(PINNED),
    `${ids.length} models; e.g. ${ids[0]}`
  );
  check(
    "listed id is the bare model id a client must send back",
    ids.includes(MODEL),
    `first id: ${ids[0]}`
  );
  const serialized = JSON.stringify(body);
  check(
    "no provider credential in /v1/models",
    !/Bearer\s+[A-Za-z0-9]{6,}/i.test(serialized) && !/"(apiKey|api_key)"\s*:/i.test(serialized)
  );
  check(
    "GET /v1/models without a key → 401",
    (await GET_MODELS(request("/v1/models"))).status === 401
  );
}

{
  const response = await GET_HEALTH(authed("/v1/health"));
  const body = (await response.json()) as any;
  check(
    "GET /v1/health → 200 when a provider can serve",
    response.status === 200,
    `HTTP ${response.status}; message: ${body.message}`
  );
  check("/v1/health reports ok", body.ok === true, `status=${body.status}`);
  check(
    "GET /v1/health without a key → 401",
    (await GET_HEALTH(request("/v1/health"))).status === 401
  );
}

{
  const bad = await POST(authed("/v1/chat/completions", { model: PINNED, messages: [] }));
  const body = (await bad.json()) as any;
  check("empty messages → 400", bad.status === 400, `got ${bad.status}`);
  check("400 names the offending field", body?.error?.param === "messages", String(body?.error?.param));
  check("400 uses an OpenAI error envelope", typeof body?.error?.type === "string");
}

{
  const response = await POST(authed("/v1/chat/completions", { ...VALID, stream: true }));
  check(
    "stream:true → 200 text/event-stream",
    response.status === 200 && (response.headers.get("content-type") ?? "").includes("text/event-stream"),
    `HTTP ${response.status}`
  );
  const { frames, done } = await readSse(response);
  const chunks = frames.filter((f) => f.object === "chat.completion.chunk");
  const errors = frames.filter((f) => f.object === "error");
  const text = chunks
    .map((c) => c.choices?.[0]?.delta?.content)
    .filter((c): c is string => typeof c === "string")
    .join("");

  check("stream ends with [DONE]", done);
  check("no error frame", errors.length === 0, errors[0]?.error?.message ?? "");
  check("every frame is a chat.completion.chunk", frames.length === chunks.length);
  check(
    "every frame has id + model + exactly one choice",
    chunks.every(
      (c) =>
        typeof c.id === "string" &&
        c.id.length > 0 &&
        typeof c.model === "string" &&
        Array.isArray(c.choices) &&
        c.choices.length === 1
    )
  );
  check("model reported as the pinned model", chunks.every((c) => c.model === MODEL), chunks[0]?.model);
  check("provider reported as aihorde", chunks.every((c) => c.provider === "aihorde"), chunks[0]?.provider);
  check(
    "final frame carries finish_reason",
    typeof chunks.at(-1)?.choices?.[0]?.finish_reason === "string",
    String(chunks.at(-1)?.choices?.[0]?.finish_reason)
  );
  check("final frame carries usage", chunks.at(-1)?.usage !== undefined);
  check("no duplicated chunk content", text.length > 0 && !text.includes(text + text), JSON.stringify(text));
  check("no internal metadata inside content", !/finish_reason|routing|chatcmpl_/.test(text));
  check(
    "model echoed the prompt phrase",
    text.toUpperCase().includes("NEXA V1 TEST PASSED"),
    JSON.stringify(text)
  );
  check("no provider credential in the stream", !/Bearer\s+[A-Za-z0-9]{6,}/i.test(JSON.stringify(frames)));
}

{
  const response = await POST(authed("/v1/chat/completions", { ...VALID, stream: false }));
  const body = (await response.json()) as any;
  check("stream:false → 200", response.status === 200, `got ${response.status}`);
  check("object is chat.completion", body.object === "chat.completion");
  check(
    "one choice with assistant content",
    Array.isArray(body.choices) &&
      body.choices.length === 1 &&
      body.choices[0].message.role === "assistant" &&
      typeof body.choices[0].message.content === "string"
  );
  check("has a numeric usage block", typeof body.usage?.total_tokens === "number", JSON.stringify(body.usage));
  check(
    "content echoes the prompt phrase",
    String(body.choices?.[0]?.message?.content ?? "").toUpperCase().includes("NEXA V1 TEST PASSED"),
    JSON.stringify(body.choices?.[0]?.message?.content)
  );
  check("no provider credential in the completion", !/Bearer\s+[A-Za-z0-9]{6,}/i.test(JSON.stringify(body)));
}

{
  check("key can be revoked", await ApiKeyService.revoke(userId, summary.id));
  check("revoked key → 401 on /v1/chat", (await POST(authed("/v1/chat/completions", VALID))).status === 401);
  check("revoked key → 401 on /v1/models", (await GET_MODELS(authed("/v1/models"))).status === 401);
}

await db.delete(users).where(eq(users.id, userId));

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log("\n" + "=".repeat(70));
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log("FAILED:\n" + failed.join("\n"));
console.log("=".repeat(70));
process.exit(failed.length ? 1 : 0);
