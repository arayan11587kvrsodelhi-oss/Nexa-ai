# NEXA AI — Architecture

**NEXA AI — Your Private AI Workspace.**
A local-first, privacy-preserving AI workspace built on Next.js 16 / React 19 / TypeScript,
PostgreSQL + Drizzle ORM, with Ollama as the primary inference provider.

This document describes the architecture **as it exists in the repository**, and clearly marks
what is implemented, what is partial, and what is not yet built. It is not a wish list.

---

## 1. High-level shape

```
┌──────────────────────────────────────────────────────────────┐
│  Browser (React 19 client components)                        │
│  ┌────────────┬───────────────────────────────┬───────────┐  │
│  │  Sidebar   │            Chat               │  Panels   │  │
│  │ chats      │   conversation + composer     │ models    │  │
│  │ projects   │                               │ files     │  │
│  │ files      │                               │ memory    │  │
│  │ agents     │                               │ tools     │  │
│  │ settings   │                               │           │  │
│  └────────────┴───────────────────────────────┴───────────┘  │
└───────────────────────────┬──────────────────────────────────┘
                            │  fetch / SSE (text/event-stream)
┌───────────────────────────▼──────────────────────────────────┐
│  Next.js 16 App Router — Route Handlers (src/app/api/**)     │
│  /api/chat  /api/conversations  /api/files  /api/memory      │
│  /api/models  /api/projects  /api/search  /api/tools         │
│  /api/health                                                 │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│  Service layer (src/lib/**)                                  │
│                                                              │
│  ai/        provider adapters, registry, router, inference    │
│  rag/       chunker, embeddings, retriever                    │
│  memory/    explicit long-term memory                         │
│  tools/     tool registry + executor                          │
│  search/    web search abstraction (SearXNG/Brave/Tavily)     │
│  agents/    goal → plan → tool → inspect → result             │
│  security/  sanitization, SSRF guard, audit log, rate limit   │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│  PostgreSQL via Drizzle ORM (src/db)                         │
│  + pgvector (OPTIONAL — not available by default)            │
└──────────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│  External / local providers                                  │
│  Ollama  •  OpenAI-compatible (LM Studio/vLLM)  •  SearXNG   │
│  FreeLLMAPI (external OpenAI-compatible, opt-in)             │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Module map

### `src/app/` — Next.js App Router

| Path | Kind | Status |
| --- | --- | --- |
| `layout.tsx` | Root layout | **Starter template.** Still titled "Arena Next.js PostgreSQL Starter". |
| `page.tsx` | Home page | **Starter template.** Renders a starter card, not the NEXA workspace. |
| `globals.css` | Styles | Tailwind v4 import only. **No NEXA design system.** |
| `api/chat/route.ts` | SSE chat endpoint | **Functional.** See §4. |
| `api/conversations/*` | CRUD | Functional, **no auth / no ownership**. |
| `api/files/*` | Upload + index + query | Functional for text; **PDF/DOCX extraction not real**. |
| `api/memory/*` | Memory CRUD | Functional, **no ownership**. |
| `api/models/*` | Config + connection test | Functional. |
| `api/projects/*` | CRUD | Functional, **no ownership**. |
| `api/search/route.ts` | Web search | Functional; honest failure when unconfigured. |
| `api/tools/route.ts` | List/execute tools | Functional but **unguarded**. |
| `api/health/route.ts` | DB ping | Functional. |

### `src/lib/ai/` — inference stack

- **`types.ts`** — `ModelProvider` interface (`testConnection`, `listModels`, `generateStream`, optional `embed`), `StreamEvent`, `GenerateOptions`, `ProviderConnectionResult`. Clean abstraction; preserved as-is.
- **`providers/ollama.ts`** — Real HTTP streaming against `POST /api/chat` (NDJSON). Connection test via `GET /api/tags`. Handles `reasoning_content`. **Real, no simulation.**
- **`providers/openai-compatible.ts`** — Real SSE streaming against `POST /chat/completions`, model listing via `GET /models`. Used for LM Studio / vLLM / any OpenAI-compatible endpoint.
- **`providers/freellmapi.ts`** — First-class FreeLLMAPI provider (an OpenAI-compatible backend): `GET /v1/models` + `POST /v1/chat/completions`, real SSE parsing with `[DONE]` termination, bounded stdlib timeouts/limits, abort propagation, and null-preserving model discovery. Credentials come from the server environment only. See [`docs/PROVIDERS.md`](./PROVIDERS.md).
- **`providers/factory.ts`** — The single place adapters are constructed (`createProvider`, `isProviderType`, `resolveProviderType`, `describeProvider`). Implements **no** fallback: a failure in one provider never yields another provider.
- **`providers/demo.ts`** — Returns **canned strings**, streamed word-by-word with `setTimeout`. It is a UI sandbox. It must never be reachable silently, and it is unreachable from the FreeLLMAPI path by construction.
- **`provider-errors.ts`** — `ProviderError` plus classification/redaction helpers. Turns wire failures into a sanitized code + health status (`available`/`unavailable`/`timeout`/`unauthorized`/`rate_limited`/`misconfigured`) and strips credentials from anything derived from upstream text.
- **`registry.ts`** — `DEFAULT_MODELS` array + `PROFILE_METADATA` (the curated local catalogue, unchanged), plus `ProviderRegistry`: provider identities, real capabilities (`null` = unknown/not claimed), and models discovered from each provider's own endpoint. Discovered models are not force-fitted into `ModelDescriptor`, so no context window or capability flag is invented.
- **`router.ts`** — Keyword-based routing to a profile. Heuristic, not learned. Provider-aware: when FreeLLMAPI is the active provider it can only route to model ids that FreeLLMAPI reported, and `selectProvider()` never substitutes another provider.
- **`inference.ts`** — Resolves the active provider from the DB config then the environment, probes it, and streams. Ollama and OpenAI-compatible behaviour is unchanged; FreeLLMAPI is health-checked and model-discovered. **Demo fallback is explicit opt-in (`ALLOW_DEMO_FALLBACK=true`) and applies to Ollama only — a FreeLLMAPI failure always surfaces as a provider-unavailable error.**

### `src/lib/rag/` — retrieval

- **`chunker.ts`** — Real overlapping paragraph/character chunker with char offsets. `extractText()` only handles JSON/CSV cosmetics.
- **`embeddings.ts`** — `LocalEmbeddingService`: **256-dim FNV-1a feature hashing**, L2-normalized. It is a lexical hash, **not a semantic embedding model** and must not be described as one.
- **`retriever.ts`** — Loads **every chunk of every eligible document into application memory**, then scores 70% hash-cosine + 30% substring overlap in JS. No pgvector, no SQL-side similarity, no pagination.

### `src/lib/memory/` — memory
`MemoryService` with regex-based explicit-memory detection, store, list, and prompt formatting. Real, simple, unowned.

### `src/lib/tools/` — tools
`BUILTIN_TOOLS` registry (calculator, datetime, file_search, document_reader, web_search, json_parser, code_formatter, text_extraction) and `ToolExecutor`. The calculator is a genuine recursive-descent parser with **no `eval`** — genuinely safe. `code_formatter` only trims trailing whitespace and claims to "format". Inputs are **not** Zod-validated.

### `src/lib/search/` — web search
`WebSearchService.search()` tries SearXNG → Tavily → Brave and returns an explicit `error` when nothing is configured. Honest design; preserved.

### `src/lib/agents/` — orchestration
`AgentOrchestrator.executeGoal()` produces a **fixed 3-step script** with keyword-selected tool use. The "thought" strings are templates. Real work: one tool call. **Not an actual plan→act→observe loop.**

### `src/lib/security/`
- `sanitize.ts` — filename sanitization, upload validation, and an SSRF check that blocks **only** `169.254.169.254` and `metadata.google.internal`.
- `audit.ts` — best-effort audit log insert.

### `src/db/`
`schema.ts` (9 tables) + `index.ts` (pooled Drizzle client). **No `users` table. No ownership columns. No foreign keys except `messages → conversations` and `document_chunks → documents`. No indexes. No migrations folder.**

---

## 3. Data model (current)

```
conversations ──< messages
projects      ──< documents ──< document_chunks
memories      (standalone)
tool_calls    (conversation_id is a loose TEXT, not an FK)
model_configs (single active row, no owner)
agent_runs    (standalone)
audit_logs    (standalone)
```

Missing relationships: `documents.projectId` and `conversations.projectId` are plain TEXT with no FK.
Nothing is owned by anyone.

---

## 4. The chat request lifecycle (`POST /api/chat`)

1. Parse body, require a non-empty `messages` array.
2. Create the conversation row if `conversationId` is absent (title = first 48 chars of the prompt).
3. Persist the user message.
4. Detect an explicit memory directive (`remember that …`) and store it.
5. Route to a model profile via `ModelRouter.route()`.
6. Open a `TransformStream` and return `text/event-stream`.
7. In a detached async task:
   a. Gather RAG chunks (if the prompt looks document-ish) → emit `citation` events.
   b. Optionally run a web search → emit `citation` events.
   c. Optionally run the calculator when the prompt matches a math-ish regex.
   d. Load active memories; compose the system prompt.
   e. Stream from the provider, forwarding `token` / `reasoning` events.
   f. Persist the assistant message with citations, tool calls, model, and latency.
   g. Emit `done` with the message id, then close.

**Note:** the user message is persisted *before* the model call, and on provider failure the
assistant message is simply never written. There is no abort propagation from the client, and
`options.signal` is never populated by the route.

---

## 5. Security posture (current)

| Control | State |
| --- | --- |
| Authentication | **Absent.** Every endpoint is public. |
| Authorization / ownership | **Absent.** Any caller can read/modify any record by id. |
| Rate limiting | **Absent.** |
| Request validation | Ad-hoc `String(body.x || "")`; no Zod schemas on routes. |
| SSRF protection | **Weak** — two hostnames blocked. |
| Path traversal | Filename sanitization only; no filesystem writes exist. |
| Secure headers | **Absent.** |
| API error sanitization | **Absent** — raw `err.message` returned to clients. |
| Provider API keys to browser | Keys stay server-side, but `GET /api/models` echoes config fields back. |
| Shell execution | **Good** — no shell execution anywhere. Calculator avoids `eval`. |

---

## 6. Architectural principles for v1.0

These govern the transformation and must not be violated:

1. **Never fake a capability.** No simulated search, citations, OCR, reasoning, or parsing.
2. **Demo mode is explicit and labelled.** It is opt-in, never an automatic fallback.
3. **Local-first, provider-agnostic.** Ollama is primary; OpenAI-compatible/vLLM and FreeLLMAPI are opt-in peers behind the same interface.
4. **Discover, don't assume.** Model capabilities come from provider metadata, not a hard-coded list.
5. **Ownership is enforced in SQL**, not in a UI filter.
6. **Retrieval happens in the database.** Vectors are never fully loaded into application memory per query.
7. **Progress is only claimed when a command proves it.**