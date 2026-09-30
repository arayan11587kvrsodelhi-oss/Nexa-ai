# NEXA AI Gateway — Provider Capability Matrix

Derived from the implementation, not from assumptions. "Incremental" means the
adapter delivers tokens as they arrive; "single-chunk" means the upstream answers
in one body and NEXA re-frames it (the client still streams, in one piece).

| Provider | Discovery | Health | Streaming | `auto` eligible | Credential | Vercel-safe |
|---|---|---|---|---|---|---|
| `aihorde` | `GET {base}/models` (24 models live) | `GET /models` probe | **single-chunk** (`supportsStreaming: false`, reported honestly) | yes | optional — anonymous `0000000000` works; a real key only raises queue priority | **yes** (public https) |
| `ollama` | `GET /api/tags` | `testConnection()` | **incremental** (NDJSON) | yes | none | **no** — loopback, disabled in production |
| `freellmapi` | `GET {base}/v1/models` (one call serves health + discovery) | same call, 30s cache | **incremental** (SSE) | yes | optional `FREELLMAPI_API_KEY` | **only** if hosted at a reachable external URL |
| `openai_compatible` | `GET {base}/models` | `testConnection()` | **incremental** (SSE) | yes | optional `OPENAI_COMPATIBLE_API_KEY` | yes, if the endpoint is externally reachable |
| `vllm` | same adapter as `openai_compatible` | same | **incremental** | yes (only if named in `NEXA_PROVIDER_ORDER`) | optional | yes, if reachable |

## Error categories per provider

All five normalize into the same `GatewayError` taxonomy, so routing, retry and
the client-facing error are provider-independent:

| Situation | Category | HTTP |
|---|---|---|
| upstream timeout | `timeout` | 504 |
| upstream 429 | `rate_limit` | 429 |
| upstream 401/403 | `authentication_failure` | 502 |
| model not found / 404 | `invalid_model` | 404 |
| connection refused, 5xx, socket reset | `temporary_upstream_failure` | 503 |
| misconfigured env / unusable base URL | `permanent_configuration_failure` | 503 |
| caller cancelled | `cancelled` | — (not retried, not fallen back) |
| bad request from the caller | `invalid_request` | 400 |

## Timeouts

| Provider | Discovery | Connect | Idle (mid-stream) |
|---|---|---|---|
| `freellmapi` | 4s | 60s | 60s |
| `aihorde` | `AI_HORDE_TIMEOUT_MS` (120s default) | same | same |
| `ollama` / `openai_compatible` / `vllm` | bounded per adapter | bounded | bounded |

Retry and fallback are bounded globally by `NEXA_GATEWAY_MAX_PROVIDER_ATTEMPTS`
(default 2), `NEXA_GATEWAY_MAX_TOTAL_ATTEMPTS` (6) and
`NEXA_GATEWAY_MAX_CANDIDATES` (4).

## Provider isolation

`provider/model` always wins. A pinned model is only ever routed to the pinned
provider, even when another provider has better priority or advertises the same
model id. Verified in `src/tests/gateway-pinning.test.ts`.

## Verified status per provider

| Provider | Verified how |
|---|---|
| `aihorde` | **real integration** — live AI Horde, real model, real network |
| `freellmapi` | **stub contract** — real adapter against a deterministic local server. Not verified against a live FreeLLMAPI 0.12.0 install (it was not running) |
| `ollama` | **unit + config tests only** — not installed in this environment |
| `openai_compatible` | **real integration** — real HTTP server, split-frame SSE |
| `vllm` | **shares the `openai_compatible` adapter**; no separate verification |
