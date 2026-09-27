# NEXA AI — Inference providers

NEXA reaches models through **one** provider abstraction:

```
src/lib/ai/types.ts        ModelProvider  (testConnection / listModels / generateStream)
        │
        ├── providers/ollama.ts             Ollama (native NDJSON, /api/chat)
        ├── providers/openai-compatible.ts  Any OpenAI-compatible endpoint
        ├── providers/freellmapi.ts         FreeLLMAPI (OpenAI-compatible)
        └── providers/demo.ts               Simulated sandbox (canned text)
                    ▲
                    └── providers/factory.ts  the single place adapters are constructed
```

Selection, routing, and failure handling are shared:

| Concern | Where |
| --- | --- |
| Adapter construction | `src/lib/ai/providers/factory.ts` |
| Active provider resolution (DB row → environment) | `InferenceService.resolveConfig()` |
| Profile/model routing | `src/lib/ai/router.ts` (`ModelRouter.route`, `ModelRouter.selectProvider`) |
| Provider identity + discovered models | `src/lib/ai/registry.ts` (`ProviderRegistry`) |
| Normalized failures | `src/lib/ai/provider-errors.ts` (`ProviderError`) |

---

## FreeLLMAPI provider

**Provider:** `FreeLLMAPI` (provider id `freellmapi`)
**Protocol:** OpenAI-compatible API

**Endpoints** (both derived from `FREELLMAPI_BASE_URL`; a trailing `/v1` in the
configured value is not duplicated):

```
<FREELLMAPI_BASE_URL>/v1/models
<FREELLMAPI_BASE_URL>/v1/chat/completions
```

**Environment:**

```bash
FREELLMAPI_BASE_URL=      # required to enable the provider; server-side only
FREELLMAPI_API_KEY=       # optional; sent as "Authorization: Bearer <key>"
FREELLMAPI_MODEL=         # optional default model id
```

### What it is

FreeLLMAPI is an **external, provider-backed route**. Requests leave this host
and are served by the FreeLLMAPI installation you point NEXA at, and by whatever
model providers that installation aggregates.

- **Availability depends on that installation and its provider pool**, not on
  NEXA. It can be up, degraded, rate-limited, or unauthorized at any time, and
  NEXA reports which of those it observed.
- **Discovered models are dynamic.** NEXA calls `GET /v1/models` at request time
  and lists exactly what the provider returns. The list can change between calls.
- **Quotas and capacity may vary** and are controlled entirely by that provider.
- **NEXA does not guarantee a specific monthly token amount, quota, model list,
  or model capability.** No such figure is displayed or implied anywhere in the
  application.

### Configuration rules

- The base URL must be configured; NEXA hard-codes no production host and makes
  no request while it is empty.
- The API key is optional, because a local installation may not require one.
  When it is absent, no `Authorization` header is sent.
- The key is **never** logged, placed in a URL, returned by an API route, or
  stored in the database. `POST /api/models` and `POST /api/models/test` reject a
  per-request `baseUrl`/`apiKey` for this provider.
- Do not commit `.env` files; only `.env.example` is versioned.

### Model discovery

`GET /v1/models` is normalized into `DiscoveredModel` rows
(`src/lib/ai/registry.ts`) and reported by `GET /api/models` under
`discoveredModels`, with `providers` describing provider-level capabilities:

```json
{
  "id": "freellmapi",
  "name": "FreeLLMAPI",
  "protocol": "openai-compatible",
  "enabled": true,
  "capabilities": { "streaming": true, "realInference": true, "tools": null, "vision": null }
}
```

Rules:

- Anything the provider does not report is `null` and is rendered as unknown.
  `null` never means "false" and never means "true".
- **Tool calling, function calling, vision, reasoning and long-context support
  are not claimed** for FreeLLMAPI models unless the provider itself reports it.
- The provider identity is preserved: the UI shows `FreeLLMAPI` plus the actual
  model id. A discovered model is never presented as an OpenAI, Anthropic, or
  Google model.
- Discovered models are **not** copied into the curated `DEFAULT_MODELS`
  catalogue, because that type requires a context window and capability flags
  that the provider may not supply. Nothing is invented to fill the gap.

### Streaming

`POST /v1/chat/completions` is called with `stream: true`. The adapter:

- parses `data: {...}` SSE frames incrementally and emits a NEXA `token` event
  per delta — the response is never buffered before display;
- terminates on `data: [DONE]` (nothing after it is emitted) and releases the
  reader;
- skips malformed frames instead of duplicating or dropping valid ones;
- ignores SSE comments and `event:`/`id:` fields;
- treats an `{"error": ...}` frame received over HTTP 200 as a provider failure;
- surfaces `reasoning_content` as `reasoning` events when a model sends it;
- emits a single token when a peer answers with a plain JSON completion instead
  of SSE (reported honestly as one chunk, not disguised as streaming).

Only the fields the NEXA abstraction carries are forwarded: `model`, `messages`
(with an optional leading `system` message), `stream`, `temperature`, `top_p`,
`max_tokens`. Unsupported fields (for example `tools`) are never sent.

### Health check

`testConnection()` performs a single `GET /v1/models` with a short timeout and
returns a structured result that never throws:

| Status | Meaning |
| --- | --- |
| `available` | The endpoint answered and reported its models |
| `unavailable` | Network failure, 5xx, or an aborted transport |
| `timeout` | No answer within the discovery budget |
| `unauthorized` | HTTP 401/403 — check `FREELLMAPI_API_KEY` |
| `rate_limited` | HTTP 429 — the provider pool is busy |
| `misconfigured` | Base URL unset/invalid, or the endpoint returned 404/400 |

Timeouts and limits: 4 s for discovery, 20 s to first response headers, 60 s
maximum silence mid-stream, plus hard caps on frame size (1 MB) and response size
(8 MB). An `AbortSignal` from the caller cancels a chat request immediately and
releases the underlying stream. All failure messages are sanitized: bearer
tokens, `sk-` keys, and the configured key itself are redacted before they reach
a log or a response.

### Routing and failure behaviour

- FreeLLMAPI is **never** an unconditional default. It is used only when the
  active configuration selects it (`DEFAULT_PROVIDER=freellmapi`, or a stored
  `model_configs` row with `provider = 'freellmapi'`).
- Existing Ollama and OpenAI-compatible behaviour is unchanged, including the
  `ModelRouter` profile heuristics.
- When FreeLLMAPI is active, the router only ever returns model ids that
  FreeLLMAPI itself reported. An Ollama model id chosen by the profile heuristic
  is never forwarded to FreeLLMAPI.
- **A FreeLLMAPI failure is never converted into demo output.** The
  `ALLOW_DEMO_FALLBACK` switch applies to Ollama only; the FreeLLMAPI path has no
  demo branch at all. Failures arrive as a normalized `ProviderError` and the UI
  explains that the provider is unavailable.
- `selectProvider()` returns the requested provider, or the configured default.
  It never substitutes a different provider, and the simulated sandbox is
  returned only when it is named explicitly.

### Verification status

Provider behaviour is covered by unit tests with a stubbed network
(`src/tests/freellmapi-provider.test.ts`) and by registry/router/inference tests
(`src/tests/freellmapi-integration.test.ts`). No live FreeLLMAPI installation was
available while these were written, so **live end-to-end inference against a real
FreeLLMAPI endpoint is unverified** and is not claimed anywhere.

