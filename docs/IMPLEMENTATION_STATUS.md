# NEXA AI — Implementation Status

**Audit date:** 2026-09-26
**Audited tree:** `c:\Users\sharm\Downloads\nexa-ai-platform-development (1)`
**Node detected:** v24.18.0 · npm 11.16.0
**Environment probe:** `node_modules` was absent (installed during audit) · PostgreSQL **not running** (127.0.0.1:5432 refused) · Ollama **not reachable** (localhost:11434 timeout) · SearXNG **not running** · Docker **not installed**

> Anything not verified by a command is marked *unverified*. Nothing here is claimed as
> working unless it was read in source or observed to run.

---

## 1. Repository inventory

38 files under `src/`, 5 config files at root, **0 tests**, **0 migrations**, **0 docs** (before this audit).

```
Root        package.json, tsconfig.json, next.config.ts, eslint.config.mjs,
            postcss.config.mjs, drizzle.config.json
src/app     3 files (layout, page, globals.css) + 13 API route files
src/db      schema.ts, index.ts
src/lib     ai/ (7), rag/ (3), memory/ (1), tools/ (2), search/ (1),
            agents/ (1), security/ (2)
src/types   index.ts
```

---

## 2. What actually works

| Capability | Evidence | Notes |
| --- | --- | --- |
| Ollama streaming inference | `src/lib/ai/providers/ollama.ts:76-164` | Real NDJSON streaming over `POST /api/chat`, handles `reasoning_content`, propagates `AbortSignal`. |
| Ollama connection test + model listing | `ollama.ts:18-74` | `GET /api/tags`. **Unverified against a live server** (Ollama not running here). |
| OpenAI-compatible streaming | `src/lib/ai/providers/openai-compatible.ts:87-171` | Real SSE parsing of `data:` frames with `[DONE]` termination. |
| Calculator | `src/lib/tools/executor.ts:211-310` | Genuine recursive-descent parser. **No `eval`, no `new Function`.** Handles `+ - * / % ^`, parens, unary minus, `sqrt/abs/round`, and raises on division by zero. |
| Document chunking | `src/lib/rag/chunker.ts:16-84` | Overlapping character chunks with `charStart`/`charEnd`/token estimate. Deterministic. |
| Conversation persistence | `src/app/api/chat/route.ts:88-102, 280-298` | User and assistant messages written to Postgres. |
| Conversation CRUD | `src/app/api/conversations/route.ts`, `[id]/route.ts` | List, create, get-with-messages, patch (title/archive/pin/profile/model), delete. |
| Explicit memory | `src/lib/memory/memory-service.ts` | Regex detection, store, list, prompt formatting. |
| Web search (SearXNG/Tavily/Brave) | `src/lib/search/web-search.ts` | Real HTTP calls. **Unverified** (no provider configured here). Returns an honest `error` string when unconfigured. |
| Audit logging | `src/lib/security/audit.ts` | Best-effort insert; swallows failures. |
| Filename sanitization | `src/lib/security/sanitize.ts:12-21` | Strips null bytes, separators, `..`, truncates to 255. |
| Health check | `src/app/api/health/route.ts` | `SELECT 1`. |
| Zod is installed | `package.json:22` | `zod@^4.6.5` — **used nowhere in the codebase.** |

---

## 3. What is incomplete

| Area | Gap |
| --- | --- |
| **UI** | `src/app/page.tsx` is still the Arena starter card. There is **no NEXA workspace**: no sidebar, no chat, no composer. `layout.tsx` still says "Arena Next.js PostgreSQL Starter". |
| **Chat client** | Nothing consumes `POST /api/chat`. No streaming client, no markdown, no code blocks, no copy, no regenerate, no edit, no stop. |
| **Chat history UI** | APIs exist; no UI. No search UI, no rename UI, no pin/archive UI. |
| **Authentication** | No `users` table, no `sessions` table, no login route, no session cookie, no middleware. **Every API route is open.** |
| **Ownership** | No `userId` column exists on any table. `conversations.projectId` and `documents.projectId` are untyped TEXT with no FK. |
| **Migrations** | `drizzle-kit` is a devDependency and `drizzle.config.json` exists, but there is **no `drizzle/` output folder and no migration files**. The schema has never been applied by this project. |
| **Indexes** | None declared. `conversations.updated_at`, `messages.conversation_id`, `documents.project_id`, `memories.is_active`, and the vector column are all unindexed. |
| **Model discovery** | `registry.ts` hard-codes 8 model IDs with asserted capability flags. Nothing merges live Ollama `/api/tags` output. `GET /api/models` reports reachability but the registry is static. |
| **vLLM** | Treated as an alias of `openai_compatible` (`inference.ts:66`). There is no vLLM-specific handling. |
| **RAG retrieval** | In-memory full-corpus scan. No pgvector. No `LIMIT`/`ORDER BY` pushdown. |
| **Code workspace** | `@monaco-editor/react` is a dependency; **zero imports of it exist**. |
| **Agent mode** | Fixed 3-step template, one real tool call, templated "thought" strings. No `maxSteps`, `timeout`, `cancellation`, permission checks, or failure recovery. No API route exposes it. |
| **Tests** | No test runner, no `test` script, no test files. |
| **Rate limiting** | Not implemented. |
| **CSRF** | Not implemented. |
| **Secure headers / CSP** | `next.config.ts` is `{}`. |
| **Error sanitization** | Route handlers return raw `err.message` to clients in ~13 places. |

---

## 4. What is simulated

### 4.1 The demo provider — `src/lib/ai/providers/demo.ts`

Returns **four canned response strings** selected by substring matching on the last user
message, delivered word-by-word with `setTimeout(r, 20)` to look like streaming. The
"reasoning" output is three fixed sentences. It performs no inference.

Its self-description is honest (`"NEXA Demo Sandbox (Simulated)"`), but see §5.1 for how it
gets activated.

### 4.2 `LocalEmbeddingService` — `src/lib/rag/embeddings.ts`

This is **256-dimensional FNV-1a feature hashing with sign-flipping over unigrams and bigrams**,
L2-normalized. Consequences that must be stated honestly:

- It is **not** a semantic embedding model. Synonyms produce near-zero similarity.
- It has **no learned parameters** and was trained on nothing.
- Collisions are frequent at 256 dimensions.

It does produce *a* deterministic vector and cosine similarity is computable, so retrieval
"works" in the sense that exact and near-exact term overlap ranks highly. It must never be
called a semantic embedding model, and the code comment claiming "semantic n-gram feature
hashing" overstates it.

### 4.3 The agent orchestrator — `src/lib/agents/orchestrator.ts`

Steps 1 and 3 are hard-coded sentences. The "Plan formulated and parameters validated" and
"Output verified and compiled" claims are not backed by any verification logic. Only step 2
performs real work (a single `ToolExecutor.execute`). The final result string asserts things
("without host elevation") that no code checked.

### 4.4 `code_formatter` — `src/lib/tools/executor.ts:131-146`

For JSON it genuinely re-serializes with `JSON.stringify(x, null, 2)` — real formatting.
For every other language it does `line.trimEnd()` and joins. It does not indent, structure,
or format anything. The registry description ("Cleans, indents, and structures source code")
is false for all non-JSON languages.

### 4.5 `DocumentChunker.extractText()` — `src/lib/rag/chunker.ts:89-110`

Handles `json` (re-serialize) and `csv` (prepend a row count). Everything else is returned
verbatim. It does not extract from any binary format.

---

## 5. What is unsafe

### 5.1 Silent demo fallback — **HIGH**

`src/lib/ai/inference.ts:80-90`:

```ts
if (process.env.ALLOW_DEMO_FALLBACK === "true" || process.env.NODE_ENV !== "production") {
  return { provider: new DemoSandboxProvider(), isDemo: true, ... };
}
```

If Ollama is unreachable, any **development or default** deployment silently answers with
canned text. The stream does report `isDemo: true` in the `done` event and the DB stores
`"NEXA Demo Sandbox Engine"` as `modelUsed`, but nothing in the response path forces that to
the user's attention, and `NODE_ENV !== "production"` means it is on by default for the
common case. **This is the single most serious "fake capability" risk in the repository and
directly violates the v1.0 no-fake rule.**

### 5.2 No authentication or authorization — **HIGH**

No `users` table exists. Every route handler trusts its inputs. `GET /api/conversations`
returns all conversations for every caller; `DELETE /api/files/[id]` deletes any document.
`PATCH /api/conversations/[id]` accepts `systemPrompt` from anyone.

### 5.3 Open tool execution — **HIGH**

`POST /api/tools` (`src/app/api/tools/route.ts:17-27`) accepts an arbitrary `toolName` and an
arbitrary `input` object and executes it with no auth, no rate limit, and **no schema
validation**. `web_search` (medium risk) and `file_search` (which performs `ILIKE` against
`documents.raw_content` across the whole corpus) are both reachable this way.

### 5.4 Unvalidated ILIKE interpolation — **MEDIUM**

`src/lib/tools/executor.ts:67`:

```ts
.where(or(ilike(documents.name, `%${q}%`), ilike(documents.rawContent, `%${q}%`)))
```

Drizzle parameterizes the value, so this is **not** SQL injection, but `q` is unescaped for
`%` and `_`, so a caller can force a full-table scan with `q = "%"`. Combined with 5.3 this
is a cheap denial-of-service on the documents table.

### 5.5 Weak SSRF protection — **MEDIUM**

`src/lib/security/sanitize.ts:48-67` blocks exactly `169.254.169.254` and
`metadata.google.internal`, and requires `http:`/`https:`. Not blocked: `127.0.0.1`,
`localhost`, `0.0.0.0`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`
generally, `::1`, IPv4-mapped IPv6, decimal/octal/hex encodings of those addresses, or
DNS names that resolve into them. Redirects are not followed safely.

`isSafeUrl` is currently **not called by any code path** (grep: only the definition exists),
so today this is latent rather than exploitable — but it must be correct before any
server-side fetch is added.

### 5.6 Raw error disclosure — **MEDIUM**

Every route handler does `NextResponse.json({ error: errorMsg })` with the raw
`err.message`. Postgres and driver errors can leak table names, column names, constraint
names, and connection strings.

### 5.7 Unbounded RAG memory usage — **MEDIUM**

`src/lib/rag/retriever.ts:55-65` selects **all** chunks for up to 20 documents with no
`LIMIT`. With the 20 MB upload cap and ~650-char chunks, that is up to ~30k rows and,
at 256 floats each, meaningful per-request memory. Every RAG-assisted chat message pays it.

### 5.8 No rate limiting — **MEDIUM**

`POST /api/chat`, `/api/tools`, `/api/search`, and `/api/files` are all unauthenticated and
unthrottled. `/api/chat` holds an Ollama connection open for the duration of generation.

### 5.9 `agent_runs` stores "thought" text — **LOW/design**

The `steps[].thought` column persists templated internal narration. When the orchestrator is
upgraded this must **not** become a store of raw model chain-of-thought. The UI activity
stream must stay at the level of "Planning" / "Searching files" / "Running calculator".

### 5.10 Minor

- `src/db/index.ts:6-8` **throws at module load** if `DATABASE_URL` is unset, so a missing
  env var crashes the process rather than producing the required "Database connection
  unavailable." state.
- `drizzle.config.json` contains a hard-coded local credential (`postgres:postgres`). It is a
  local default, but credentials do not belong in a committed config.
- `model_configs.apiKey` is a plaintext TEXT column. Acceptable for a local-only deployment
  (it is the intended design), but it must never be returned to the browser, and the
  `/settings/models` UI must treat it as write-only.

---

## 6. What will be replaced

| Target | Replacement |
| --- | --- |
| `src/app/page.tsx` (starter card) | NEXA workspace shell: sidebar + chat + panels |
| `src/app/layout.tsx` metadata | NEXA AI branding, theme tokens, fonts |
| `src/app/globals.css` | NEXA design system (obsidian/graphite/teal), reduced-motion, light/dark |
| `LocalEmbeddingService` (feature hashing) | Real embedding provider — Ollama `/api/embed` with `nomic-embed-text` etc., plus a pgvector-or-fallback storage strategy |
| `RAGRetriever` in-memory scan | DB-side similarity search with a bounded candidate set |
| `DemoSandboxProvider` auto-fallback (`inference.ts:80-90`) | Explicit opt-in only; offline produces a hard, honest error state |
| Static `DEFAULT_MODELS` registry | Live discovery from Ollama `/api/tags` + `/api/show`, merged with a configurable catalog |
| `code_formatter` whitespace "formatting" | Real JSON/JSONC formatting, or an honest rename/description |
| `AgentOrchestrator` fixed script | Real plan→act→observe loop with `maxSteps`, `timeout`, cancellation, per-tool permissions, failure handling |
| `SecurityGuard.isSafeUrl` | Full private/link-local/loopback/IPv6/encoded-address blocking |
| Raw `err.message` responses | Sanitized error codes + safe messages |
| `documents.projectId` / `conversations.projectId` TEXT | Real foreign keys |

---

## 7. What will be preserved

These modules are sound and will be **improved in place, not rewritten**:

- `src/lib/ai/types.ts` — provider interface and stream event contract
- `src/lib/ai/providers/ollama.ts` — real streaming, already correct
- `src/lib/ai/providers/openai-compatible.ts` — real SSE, already correct
- `src/lib/ai/inference.ts` — provider selection shape (its fallback policy is the only fix)
- `src/lib/ai/router.ts` — profile concept and decision record
- `src/lib/tools/registry.ts` — tool definition shape
- `src/lib/tools/executor.ts` — **the calculator parser especially**
- `src/lib/rag/chunker.ts` — chunking with char offsets
- `src/lib/memory/memory-service.ts` — explicit-memory model
- `src/lib/search/web-search.ts` — provider chain and honest failure reporting
- `src/lib/security/audit.ts` — audit logging shape
- `src/lib/security/sanitize.ts` — filename sanitization and upload validation
- `src/db/schema.ts` — table shapes (extended, not replaced)
- `src/db/index.ts` — pooled client (error handling to be made non-fatal)
- `src/types/index.ts` — domain types

---

## 8. Environment reality check

The v1.0 quality gate requires `npm run typecheck`, `npm run lint`, `npm test`, and
`npm run build` to pass, plus 24 manual verification steps that require a live Ollama, a live
PostgreSQL, and a live search provider.

Observed on this machine:

| Requirement | Status |
| --- | --- |
| Node.js | ✅ v24.18.0 at `C:\Program Files\nodejs` (**not on `PATH`** — must be invoked by absolute path) |
| npm | ✅ 11.16.0 |
| PostgreSQL | ❌ Not installed / not listening on 5432 |
| Ollama | ❌ Not installed / not listening on 11434 |
| SearXNG | ❌ Not listening on 8080 |
| Docker | ❌ Not installed |

Consequently:

- `typecheck`, `lint`, and `build` **can** be run and will be reported.
- Anything requiring a live database (`db:migrate`, all API integration tests) **cannot** be
  run or verified here.
- Anything requiring live inference (`ollama serve`, model pull, real streaming) **cannot** be
  verified here. Unit tests will use fake providers and local HTTP stubs, which test the
  adapter's parsing and error handling but **not** a real model's output.
- Any step in the Phase 23 manual checklist that touches Postgres, Ollama, or search will be
  reported as **NOT VERIFIED — environment unavailable**, never as passed.

---

## 9. Phase plan

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Repository audit | ✅ this document |
| 1 | NEXA UI shell | pending |
| 2 | Chat experience | pending |
| 3 | Chat history | pending |
| 4 | Auth + ownership | pending |
| 5 | Model management | pending |
| 6 | Ollama first | pending |
| 7 | Real RAG | pending |
| 8 | Real file parsing | pending |
| 9 | Document UI | pending |
| 10 | Memory | pending |
| 11 | Tools | pending |
| 12 | Web search | pending |
| 13 | Agent mode | pending |
| 14 | Code workspace | pending |
| 15 | Security | pending |
| 16 | Database | pending |
| 17 | Error states | pending |
| 18 | Tests | pending |
| 19 | Performance | pending |
| 20 | UX polish | pending |
| 21 | No fake capabilities | pending |
| 22 | README | pending |
| 23 | Quality gate | pending |

---

## 10. FreeLLMAPI integration (addendum)

- **Provider adapter:** `src/lib/ai/providers/freellmapi.ts` — first-class `ModelProvider`
  implementation.
- **Provider factory:** `src/lib/ai/providers/factory.ts` — single creation point, zero
  cross-provider fallback.
- **Errors & redaction:** `src/lib/ai/provider-errors.ts` — normalized error codes + secret
  sanitization.
- **Registry & Router:** `src/lib/ai/registry.ts` (`ProviderRegistry`) + `src/lib/ai/router.ts`
  (`routeWithinFreellmapi`, non-inventing model discovery).
- **Inference hardening:** `src/lib/ai/inference.ts` — server-only credential resolution, strictly
  disallows demo fallback for FreeLLMAPI even when `ALLOW_DEMO_FALLBACK=true`.
- **API hardening:** `/api/models`, `/api/models/test`, `/api/chat` reject per-request FreeLLMAPI
  credentials/URLs and reflect honest provider status.
- **UI notices:** Shell status and workspace overview indicate active provider and external data
  flow notices.
- **Unit & integration test coverage:** `src/tests/freellmapi-provider.test.ts` (14/14 passing),
  `src/tests/freellmapi-integration.test.ts` (11/11 passing).
- **Environment:** Requires `FREELLMAPI_BASE_URL` (and optional `FREELLMAPI_API_KEY`) set on the
  server. Live end-to-end inference against a real external server remains unverified.
- **Detailed guide:** See [`docs/PROVIDERS.md`](./PROVIDERS.md).
