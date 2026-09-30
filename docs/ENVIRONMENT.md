# NEXA AI — Environment variables

Every variable the implementation actually reads. Nothing here is invented, and
no real value is shown.

Legend: **required** · optional · development-only · production-incompatible

---

## Required in production

| Variable | Purpose | Notes |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection for the app, sessions, API keys, and durable provider health. | **required.** The `api_keys` and `provider_health` tables live here. |

## Security

| Variable | Purpose | Notes |
|---|---|---|
| `NEXA_API_KEY_PEPPER` | Server-side secret mixed into every API-key digest. | **required in production.** Without it a database leak allows offline guessing of candidate keys. Changing it invalidates every existing key. Never logged, never returned, never sent to the browser. **Since Phase 5.1, hashing throws in production when it is unset or blank**, rather than silently falling back to an unkeyed digest. In development a missing pepper is still tolerated so a fresh clone runs. The error names the variable and never its value. |

## Providers — enable at least one

NEXA has no built-in model. A provider must be reachable or every request fails
with an honest `no_provider_configured` error.

| Variable | Provider | Notes |
|---|---|---|
| `AI_HORDE_ENABLED` | AI Horde | `true` to opt in. Optional — setting `AI_HORDE_API_KEY` also opts in. |
| `AI_HORDE_BASE_URL` | AI Horde | Optional. Defaults to `https://oai.aihorde.net/v1`. **Public HTTPS, works on Vercel.** |
| `AI_HORDE_API_KEY` | AI Horde | Optional. Without it the documented anonymous key is used, at lower queue priority. |
| `AI_HORDE_MODEL` | AI Horde | Optional. The model `auto` prefers for this provider. |
| `AI_HORDE_TIMEOUT_MS` | AI Horde | Optional. Queued generations can take a while. |
| `OPENAI_COMPATIBLE_BASE_URL` | LM Studio / llama.cpp / vLLM | Optional. Must be **externally reachable** in production. Include `/v1`. |
| `OPENAI_COMPATIBLE_API_KEY` | same | Optional. |
| `OPENAI_COMPATIBLE_MODEL` | same | Optional. |
| `FREELLMAPI_BASE_URL` | External FreeLLMAPI | Optional. **In production it must be a publicly reachable URL** — a loopback address will not work from Vercel. |
| `FREELLMAPI_API_KEY` | same | Optional. |
| `FREELLMAPI_MODEL` | same | Optional. |
| `OLLAMA_BASE_URL` | Local Ollama | **development-only.** Loopback is rejected when `NODE_ENV=production`. |
| `NEXA_ENABLE_LOCAL_OPENAI_COMPATIBLE` | local LM Studio | **development-only.** Same loopback restriction applies. |

### The loopback rule

`validateProviderUrl` rejects `127.0.0.1`, `localhost`, `::1` and every private
range **whenever `NODE_ENV=production`**, unless
`NEXA_ALLOW_PRIVATE_PROVIDER_HOSTS=true` is set explicitly.

Two things that flag does **not** do:

- It does not permit **link-local / cloud metadata** addresses
  (`169.254.0.0/16`, `100.100.100.200`, `fd00:ec2::254`,
  `metadata.google.internal`). Those are blocked unconditionally, because the
  flag exists to reach a local Ollama, not to reach the host's credential store.
- It does not make a loopback provider work from a hosted runtime. A serverless
  function has no `127.0.0.1` Ollama; point `OPENAI_COMPATIBLE_BASE_URL` at a
  reachable host instead.

## Routing

| Variable | Purpose | Notes |
|---|---|---|
| `NEXA_PROVIDER_ORDER` | Comma-separated provider priority for `auto`. | Optional. Unknown names are ignored. |
| `NEXA_GATEWAY_MAX_CANDIDATES` | Candidate chain length. | Optional, default 4. |
| `NEXA_GATEWAY_MAX_PROVIDER_ATTEMPTS` | Attempts per candidate. | Optional, default 2. |
| `NEXA_GATEWAY_MAX_TOTAL_ATTEMPTS` | Total attempts per request. | Optional, default 6. |
| `NEXA_GATEWAY_RETRY_BACKOFF_MS` | First backoff between attempts. | Optional, default 250. |
| `NEXA_GATEWAY_MODEL_HEALTH_TTL_MS` | How long a failure is trusted. | Optional, default 5 minutes. |

## Rate limiting

Rate limiting is **distributed**. Counters live in PostgreSQL
(`rate_limit_buckets`), so every serverless instance enforces the same quota.
An in-process `Map` would give each instance its own counter and make the real
limit scale with the instance count.

The increment and the window rollover are a single
`INSERT … ON CONFLICT DO UPDATE … RETURNING`, so concurrent requests are
serialised by the row lock and cannot collectively exceed the limit. This is
verified against a real database in `integration-rate-limit.mts` (40 parallel
statements against a limit of 10 admit exactly 10).

| Variable | Purpose | Default |
|---|---|---|
| `NEXA_V1_KEY_RATE_LIMIT` | Chat requests per window, per API key. | 60 |
| `NEXA_V1_KEY_RATE_WINDOW_SECONDS` | Chat per-key window. | 60 |
| `NEXA_V1_IP_RATE_LIMIT` | Chat requests per window, per source address. | 120 |
| `NEXA_V1_IP_RATE_WINDOW_SECONDS` | Chat per-IP window. | 60 |
| `NEXA_V1_MODELS_RATE_LIMIT` | `GET /v1/models` per key. | 60 |
| `NEXA_V1_MODELS_RATE_WINDOW_SECONDS` | `/v1/models` window. | 60 |
| `NEXA_V1_HEALTH_RATE_LIMIT` | `GET /v1/health` per key. | 60 |
| `NEXA_V1_HEALTH_RATE_WINDOW_SECONDS` | `/v1/health` window. | 60 |
| `NEXA_API_KEY_CREATE_RATE_LIMIT` | API keys created per window, per user. | 10 |
| `NEXA_API_KEY_CREATE_RATE_WINDOW_SECONDS` | Key-creation window. | 3600 |

Values are clamped to a sane range, and a non-numeric value falls back to the
default rather than propagating `NaN`.

### Policy per endpoint

| Endpoint | Dimensions | Store failure |
|---|---|---|
| `/v1/chat/completions` | per key **and** per source IP | **fail closed** (503) |
| `/v1/models` | per key | fail open (200) |
| `/v1/health` | per key | fail open (200) |
| `POST /api/chat` | per user **and** per source IP (Phase 5.2) | **fail closed** (503) |
| `POST /api/api-keys` | per user (session-authenticated) | fail closed (429) |
| `POST /api/tools` | per user (session-authenticated) | fail closed (429) |
| `POST /api/search` | per user (session-authenticated) | fail closed (429) |

Chat is the only endpoint that spends inference quota, so it is the only one
with a second dimension and the only one that refuses outright when the store
is unreachable. Model listing and health checks are cheap and read-only, and
refusing them during a database blip would turn a partial outage into a total
one — health especially, since a monitor that cannot read `/v1/health` will
report a false outage.

> **A database outage must not become unlimited inference.** That is why chat
> fails closed. The cost of that choice is availability: while the limiter
> store is down, `/v1/chat/completions` returns 503. The availability/safety
> trade is deliberate and lives in code (`failClosed` in `rateLimitConfig()`).

### Why the two session routes fail closed, and why nothing else is limited

`POST /api/tools` and `POST /api/search` are the only `/api/*` POST routes that
are limited. The rest were audited and deliberately left alone, because adding
a limit to a route that spends nothing would cost a database write per call to
constrain nothing.

| Route | Decision | Reason |
|---|---|---|
| `POST /api/tools` | **RATE LIMITED** | Two of its seven tools are not free. `web_search` calls `WebSearchService`, which spends a metered Tavily/Brave credential. `file_search` runs `ilike(documents.rawContent, %q%)` — an unindexed full scan of the document corpus on every call. |
| `GET /api/tools` | **NO LIMIT** | Serves a static in-memory registry. No network, no database, no quota. A limit here would be a write on every page load for no protection. |
| `POST /api/search` | **RATE LIMITED** | *Every* request spends something: a metered Tavily/Brave call or a SearXNG round trip. `limit` is caller-supplied and otherwise uncapped, so one request can request an arbitrarily large result set — that is the amplification knob. |
| `POST /api/chat` | **NO ADDITIONAL LIMIT** | The heaviest consumer of upstream quota in the app, and still unlimited — see the limitation noted below. |
| `/api/models`, `/api/health`, `/api/conversations`, `/api/files`, `/api/memory`, `/api/projects`, `/api/agents` | **NO LIMIT** | Local database CRUD or in-process reads. No metered upstream, no external call. |

Both limited routes fail closed, and here that costs **no availability at all**:
`requireUser` has already proven the database is reachable, so a limiter-store
outage means the route was going to fail regardless. Denying is free.

A store outage on these two is reported as **429 with a distinct message**
("The gateway is temporarily unable to accept requests"), not as an ordinary
quota refusal. The status is 429 rather than 503 because `ApiError` — the error
type this surface reports through — has no distinct "temporarily unavailable"
code, and because inventing one would change a shared error contract for two
routes. The *message* still distinguishes the two, which is what an operator
actually needs to tell an outage from ordinary throttling.

### Responses

- **429** — the quota was genuinely exceeded. Carries `Retry-After`,
  `X-RateLimit-Limit` and `X-RateLimit-Remaining`.
- **503** — the limiter store was unreachable (fail-closed). Carries
  `Retry-After` but no quota headers, because there is no meaningful quota to
  report. Reporting an outage as 429 would tell every client to back off and
  would hide a real incident behind ordinary-looking throttling.

Neither response contains a key, a hash, a bucket identifier, SQL, or a stack
trace.

### Ordering

Authentication always runs **before** the limiter. A request with an invalid or
revoked key receives **401**, never 429, and consumes no quota — so an
unauthenticated request can never spend a valid user's allowance.

One inbound request costs exactly one unit per dimension. Provider retries and
fallbacks happen further in and are budgeted separately by the gateway, so they
cannot inflate a caller's usage.

### Bucket identity and source address

Buckets are keyed by the **public key id** (16 hex characters), never by the
key itself, so no secret is ever used as a database key. `clientAddress()`
prefers `x-vercel-forwarded-for`, then `x-real-ip`, then `x-forwarded-for`, and
uses only the first hop. These headers are trustworthy because the platform
edge overwrites them; a forged value could at most move a caller into a
different bucket, never skip a check. Requests with no usable address share one
`unknown` bucket, so stripping the headers throttles only the caller.

Rows are opportunistic garbage — each is rewritten by its own window rollover
— and `pruneRateLimitBuckets()` clears anything untouched for 24 hours.

## API key creation quota

Key creation is limited per **user**, keyed by the server-resolved session id
(`NEXA_API_KEY_CREATE_RATE_LIMIT`, default 10 per hour), so a client cannot move
itself into another account's bucket by sending a header. Reads are never
charged, so a user can always list and revoke the keys they already have.

This limit previously did nothing at all: the old guard was an in-process `Map`
**and** its return value was discarded, so it never refused a request. It is
now on the shared distributed limiter and is actually enforced.

## Database migrations

`drizzle.config.ts` reads `DATABASE_URL` and nothing else. There is no fallback
connection string — a committed default with an embedded password is a real
secret in the repository, and it also silently points a developer at the wrong
database. A missing `DATABASE_URL` fails loudly.

```bash
npm run db:check      # verify schema and migrations agree (offline)
npm run db:generate   # write a migration file after editing src/db/schema.ts
npm run db:migrate    # apply migrations to DATABASE_URL
```

`db:generate` and `db:check` only diff the schema against the recorded snapshot
and never open a connection, so for those a credential-free placeholder such as
`postgresql:///placeholder` is enough. `db:migrate` needs a real `DATABASE_URL`.

**Apply migrations before deploying a new build.** `/v1/chat/completions` fails
closed, so a missing `rate_limit_buckets` table makes chat return 503 until the
migration is applied.

**Phase 5.1 required no new migration.** The two session-scoped limits reuse the
existing `rate_limit_buckets` table; they differ only in the bucket key they
write (`session:tools:<userId>` and `session:search:<userId>`).

## `POST /api/chat` — the interactive chat route (Phase 5.2)

This is the most expensive endpoint in the application, and until Phase 5.2 it
had **no limiter at all**. The `chat` policy above applies only to
`/v1/chat/completions`; it never applied here.

| Variable | Default | Notes |
|---|---|---|
| `NEXA_CHAT_USER_RATE_LIMIT` | 30 / 60s | Per signed-in user. |
| `NEXA_CHAT_USER_RATE_WINDOW_SECONDS` | 60 | |
| `NEXA_CHAT_IP_RATE_LIMIT` | 60 / 60s | Per source address; exactly 2× the user limit, matching the Phase 5 `/v1` ratio so a shared NAT is not throttled by its other members. |
| `NEXA_CHAT_IP_RATE_WINDOW_SECONDS` | 60 | |

The defaults are **not** the Phase 5 `/v1` numbers (60/120). Those were chosen
for machine clients holding an API key. This principal is a signed-in human in
an interactive UI where one request is one visible message, so 30/min is
already far above any legitimate burst while halving the worst-case cost of a
stolen session.

### Order of operations

```
requireUser           -> 401, limiter never reached
rate limit (2 buckets)-> 429 or 503, no DB write, no stream
body validation       -> 400, provider never reached
conversation/message writes
provider inference (SSE)
```

Quota is charged **before** body validation, deliberately: a malformed body
still costs quota, so an attacker cannot use garbage payloads to force unbounded
conversation/message inserts. Validation still runs before any provider call, so
malformed input never reaches a model.

### Abort behaviour

A client disconnect now propagates to the provider through a real
`AbortSignal`, so a model does not keep generating to completion for output
nobody will read. This is a **cost** control, not a quota control: the request
was already charged, and an abort never refunds it — otherwise a client could
start expensive work and abort to obtain unlimited effective attempts.

## Provider amplification

`runWithFallback` bounds retries to **2 attempts per candidate** and **6 total**
(`NEXA_GATEWAY_MAX_PROVIDER_ATTEMPTS`, `NEXA_GATEWAY_MAX_TOTAL_ATTEMPTS`), and
only for transient failures. So one client request can cost **at most 6 upstream
attempts**, and only when providers are genuinely failing. The limiter counts
the *client* request, which is the correct unit for abuse control; the retry
multiplier is a remaining cost consideration, not a bypass.

## `POST /api/agents` — agent runs (Phase 5.3)

Verified before changing anything: an agent run reached the **same** tool
implementations that `/api/tools` and `/api/search` limit — `web_search`
(metered Tavily/Brave/SearXNG) and `file_search` (an unindexed `ilike` scan
over `documents.rawContent`) — but by calling `ToolExecutor.execute` directly.
A limiter on those two HTTP routes cannot observe a direct function call, so
this route was a way around both.

| Variable | Default | Notes |
|---|---|---|
| `NEXA_AGENT_USER_RATE_LIMIT` | 20 / 60s | Per signed-in user. |
| `NEXA_AGENT_USER_RATE_WINDOW_SECONDS` | 60 | |
| `NEXA_AGENT_IP_RATE_LIMIT` | 60 / 60s | Per source address; 3× the user limit. |
| `NEXA_AGENT_IP_RATE_WINDOW_SECONDS` | 60 | |

Order: `requireUser` → validate goal → limit → agent runs → tool call. A refused
run creates no `agent_runs` row and invokes no tool. A limiter-store outage is
**503**; an exhausted quota is **429**.

This is a **request-level** quota, separate from the tool endpoints' own
quotas — an agent run is a different operation from a direct tool invocation,
and both are bounded. It is not a second charge for the same work: the agent's
internal tool call is not separately limited, because the orchestrator's
execution is structurally capped at exactly **one** tool call (a fixed
three-step script with no loop and no client-supplied iteration count).

### Agent tool ownership

`AgentOrchestrator` now passes the authenticated `userId` into
`ToolExecutor.execute`. It previously omitted it, and `ToolExecutor` treats a
missing `userId` as *"no ownership filter"* rather than *"deny"* — so the
agent's `file_search` returned documents belonging to **every** user whenever a
goal contained "search", "find" or "look up".

## Search result ceiling

`WebSearchService.search` clamps `limit` to at most **10** before it reaches any
provider. Previously `limit` flowed from the caller straight to `max_results`
(Tavily) or `count=` (Brave) with no upper bound.

The cap lives in the shared implementation rather than at each call site,
because all three entry points — `/api/search`, the `web_search` tool from
`/api/tools`, and the same tool from `/api/agents` — pass through it. Clamping
at the call sites would be three places to keep in sync, and the next caller
would forget.

## `POST /api/files` — document upload (Phase 5.4)

Verified: this route had **no application-level limit at all**, while one
accepted upload performs a 20 MB body read, a document insert carrying the whole
raw text, chunking at 650 chars, a `generateEmbedding` call *per chunk*, and
batched chunk inserts. On a ~1 MB document that is roughly 1,500 embedding
computations plus several round trips, so repeated uploads are both a CPU/IO
amplifier and unbounded storage growth.

| Variable | Default | Notes |
|---|---|---|
| `NEXA_FILE_UPLOAD_USER_RATE_LIMIT` | 10 / 60s | Per signed-in user. |
| `NEXA_FILE_UPLOAD_USER_RATE_WINDOW_SECONDS` | 60 | |
| `NEXA_FILE_UPLOAD_IP_RATE_LIMIT` | 20 / 60s | Per source address; 2× the user limit. |
| `NEXA_FILE_UPLOAD_IP_RATE_WINDOW_SECONDS` | 60 | |

Order: `requireUser` → **limit** → body parse → expensive work. The check runs
before `req.formData()` / `req.json()`, so a refused upload does not even buffer
the body, and before the ownership lookup and every write. A limiter-store
outage is **503**; an exhausted quota is **429**.

`GET /api/files` is deliberately **not** limited: it is a bounded,
ownership-scoped read of 50 rows.

## Cross-origin state changes (Phase 5.4)

NEXA already blocked the practical CSRF vector without an explicit mechanism:
the session cookie is `HttpOnly` + `SameSite=Lax`, and **every** state-changing
endpoint is a POST/PUT/PATCH/DELETE — verified that no handler mutates state on
GET. A cross-site browser POST therefore does not carry the session cookie at
all.

Phase 5.4 adds one small check in `middleware.ts` as defence in depth for what
that leaves open: a same-site attack from a sibling subdomain, a client that
ignores `SameSite`, or a future change to the cookie attributes.

Deliberate design points:

- **No token system.** Origin validation is the smallest mechanism that closes
  the residual gap; a token on every route would be redundant.
- **API-key clients are untouched.** `/v1` is excluded by the matcher and is
  bearer-authenticated, so browser CSRF rules are never imposed on it.
- **A missing `Origin` is allowed.** Browsers always send `Origin` on a
  cross-site state-changing request, so its absence means a non-browser client
  (curl, scripts, server-to-server) rather than a forged browser attack.
  Rejecting it would break the API surface for no security gain.
- **Read-only requests are never refused.** `SameSite=Lax` *does* send the
  cookie on a top-level cross-site GET, so blocking cross-origin GETs would add
  no protection while risking breakage.
- An unparseable `Origin`, and the opaque `null` origin, are both refused.

## Document search — pattern safety and tenant scope

`file_search` builds its LIKE pattern with the search term **escaped**
(`sanitizeLikePattern`) and an explicit `ESCAPE` clause. Previously the term was
interpolated raw, so a caller could pass `%` and turn a search into "match every
document" — a guaranteed-match scan that never short-circuits, returning results
nobody asked for.

`file_search` and `document_reader` also **fail closed** when no owner is
supplied, returning an empty result rather than every tenant's rows. The routes
always pass the authenticated id, so this costs nothing.

**On indexing:** a normal B-tree index does **not** accelerate
`ILIKE '%term%'` — the leading wildcard makes the pattern unanchored, so there
is no prefix to seek. `documents_user_id_idx` already exists, and it does help:
it narrows the scan to the calling tenant before the text match. Eliminating the
remaining per-tenant scan would require a `pg_trgm` GIN index, which is a
migration and an extension dependency, and whose build/maintenance cost over
full document text is not justified for a private workspace. The rate limits
bound the abuse in the meantime.

**Known and deliberately not changed:** `GET /api/conversations?q=` still
interpolates its search term raw into `ilike(conversations.title, ...)`. It is
**tenant-scoped** (`eq(conversations.userId, user.id)`) and capped at
`.limit(50)` over one user's own conversations, so it is a result-quality wart
rather than a boundary violation or a meaningful resource risk. Left alone to
keep this phase focused; worth escaping for consistency.

## Test database (integration tests)

**`DATABASE_URL` is NOT the integration-test target.** Automated tests may only
use a database explicitly designated by `NEXA_TEST_DATABASE_URL` (or
`TEST_DATABASE_URL`). There is deliberately **no fallback** to `DATABASE_URL`.

This matters because Vitest (and the suites themselves) load `.env` into
`process.env`, so `DATABASE_URL` — the configured, and in a real deployment
production, database — is present on every `npm test`. Several suites create real
users and API keys. Without an explicit test target they would write into
production data.

### Operator setup

```bash
# 1. Create a disposable database.
createdb nexa_test

# 2. Apply migrations to it (the runner does this for you).
NEXA_TEST_DATABASE_URL=postgresql://user:pw@127.0.0.1:5432/nexa_test \
  npm run db:migrate

# 3. Run the integration suites.
NEXA_TEST_DATABASE_URL=postgresql://user:pw@127.0.0.1:5432/nexa_test \
  npx tsx scripts/run-integration.mts
```

The database must be **disposable**: the suites create and delete rows.

### Safety rules the runner enforces

`scripts/run-integration.mts` aborts **before any suite loads** when:

| Condition | Result |
| --- | --- |
| `NEXA_TEST_DATABASE_URL` / `TEST_DATABASE_URL` not set | ABORT |
| The URL is not `postgres://` / `postgresql://` | ABORT |
| The host looks like a managed production instance (Neon, Supabase, RDS, …) | ABORT |
| The host is not loopback and `NEXA_ALLOW_REMOTE_TEST_DATABASE` is not `true` | ABORT |
| `DATABASE_URL` would have to be used as a fallback | never happens |

`NEXA_ALLOW_REMOTE_TEST_DATABASE=true` is for a genuinely disposable remote
instance you have confirmed can be dropped. It does **not** override the
managed-production-host block.

Unit tests that need a database (`password-reset.test.ts`) apply the same guard
and **skip** when no test database is configured, rather than silently using
`DATABASE_URL`.

## Unauthenticated surfaces

`GET /api/health` and `HEAD /api/health` are intentionally unauthenticated so a
load balancer or uptime monitor can call them. They report only liveness
signals — `ok`, `app`, `version`, database reachability, and the coarse provider
name.

They deliberately report **no provider endpoint**. Internal hosts, IPs and ports
are not published from an anonymous route; the diagnostics panel reads engine
detail from the session-authenticated `/api/models` instead.

Everything else under `/api/*` requires a session, and `/v1/*` requires a
bearer API key.

## Provider endpoint trust boundary

A provider endpoint may only ever come from **server-side configuration or an
operator-validated user setting** — never straight from a request body.

`POST /api/models` persists a `baseUrl` that `GET /api/models` and `/api/chat`
subsequently fetch. That value is validated with the same `validateProviderUrl`
the gateway already applies to operator-configured providers, so a
user-configured endpoint is held to one policy:

- `http:` or `https:` only, and never with embedded credentials;
- **never** a cloud-metadata host (`169.254.169.254`, `metadata.google.internal`,
  `100.100.100.200`, and the whole `169.254.0.0/16` link-local block) — this
  block is unconditional and cannot be relaxed by the opt-in below;
- never a loopback, private or link-local target **unless** the operator has set
  `NEXA_ALLOW_PRIVATE_PROVIDER_HOSTS=true` (or is running in development, where
  reaching a local Ollama is the intended workflow).

Bring-your-own-endpoint is preserved: a public `https://` endpoint is accepted
and stored. A call that supplies a per-request endpoint is rejected outright by
`POST /api/models/test` and `/api/models`.

**Known, documented limitation:** `validateProviderUrl` does not resolve DNS, so
a hostname that *resolves* to a private address is only caught by the
private-host opt-in, and the module never follows redirects.

## Rate-limit IP trust boundary

`clientAddress()` trusts `x-vercel-forwarded-for`, then `x-real-ip`, then
`x-forwarded-for`, taking only the first hop, validating it as an address
format, and truncating it to 64 characters.

- **Vercel (the supported public deployment):** the edge overwrites these
  headers, so they are trusted metadata and cannot be forged by a client.
- **Direct-origin exposure:** a client *can* vary `x-forwarded-for` per request
  and obtain a fresh bucket. The per-user quota still applies — it is keyed by
  the server-resolved session id, not by address — so only the address dimension
  is weakened, never the identity one.
- **No proxy header at all:** the request lands in the `unknown` bucket, which
  is *shared* and therefore more restrictive, not a bypass.

Set `NEXA_ALLOW_PRIVATE_PROVIDER_HOSTS` and the trusted-proxy assumption
together when deploying anywhere other than Vercel.

## Browser security headers



Set in `next.config.ts`, sourced from `src/lib/security/headers.ts` so the
policy is unit-tested rather than asserted against Next's plumbing. No
configuration is required — the policy is not operator-tunable, because a
weakened header set is worse than no header set at all.

| Header | Value | Why |
|---|---|---|
| `Content-Security-Policy` | see below | The core control. |
| `X-Content-Type-Options` | `nosniff` | Stops a browser re-interpreting a response as a script type. |
| `Referrer-Policy` | `no-referrer` | A referrer would carry conversation ids and password-reset tokens in its path. |
| `Permissions-Policy` | camera, microphone, geolocation, payment, USB, sensors all `()` | The app uses none of these. |
| `X-Frame-Options` | `DENY` | Legacy clickjacking defence alongside `frame-ancestors`. |
| `X-XSS-Protection` | `0` | The old auditor was itself exploitable; disabling it is the modern recommendation. |
| `X-DNS-Prefetch-Control` | `off` | A private workspace contacts no third party, so prefetch is pure DNS leakage. |
| `Strict-Transport-Security` | `max-age=31536000` | **Production only.** Scoped to the apex domain — `includeSubDomains`/`preload` would reach hosts this app does not own. |

### CSP, and what it cost to get right

```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none';
base-uri 'self'; form-action 'self'; frame-ancestors 'none'; manifest-src 'self';
worker-src 'self'; upgrade-insecure-requests
```

The policy was derived by inspecting the application, not copied from a
template:

- **`connect-src 'self'` is the directive that matters most here.** Every
  browser-side `fetch` targets a relative `/api/...` path, so this blocks *all*
  exfiltration channels — `fetch`, `XMLHttpRequest`, `sendBeacon`,
  `WebSocket`, `EventSource` — without breaking anything. It is the real
  compensating control for `'unsafe-inline'` in `script-src`.
- **No `unsafe-eval` in production.** Nothing in NEXA evaluates strings; the
  calculator is a hand-written recursive-descent parser specifically so this can
  stay true. A test asserts it never appears.
- **No wildcard in any source directive**, and no third-party origin anywhere.
  Fonts are self-hosted by `next/font`, the app renders no `<img>` and no
  `next/image`, and it makes no external browser connections.
- **`'unsafe-inline'` for `script-src` is a known, deliberate compromise.**
  Next.js emits an inline RSC flight payload (`self.__next_f.push(...)`) whose
  content differs per request, so it cannot be whitelisted by hash. A nonce
  would remove the exception, but only by forcing every page to render
  dynamically — `/login`, `/signup`, `/forgot-password` and `/reset-password`
  are currently prerendered. That is a larger behavioural change than a
  hardening pass should make. To close it properly, adopt per-request nonces
  and accept dynamic rendering for those four pages.
- **`'unsafe-inline'` for `style-src` is required by the current UI.** Around
  70 components set `style={{...}}` for theme-aware colours and borders.
  Inline *attributes* are governed by `style-src-attr`, and there is no
  nonce mechanism for them. CSS injection is a materially smaller risk than
  script injection.

### Development vs production

Development is looser only where the toolchain requires it, and the difference
is asserted by a test so it cannot invert:

| | Development | Production |
|---|---|---|
| `script-src` | adds `'unsafe-eval'` (React Fast Refresh) | no `unsafe-eval` |
| `connect-src` | adds `ws:` / `wss:` (HMR) | `'self'` only |
| HSTS + `upgrade-insecure-requests` | **absent** | present |

HSTS and `upgrade-insecure-requests` are omitted in development on purpose: sent
over plain `http://localhost`, they can make a browser refuse to load the dev
server, which presents as an unrelated breakage.


## Verifying a deployment

```bash
curl -i https://YOUR-DOMAIN/v1/health -H "Authorization: Bearer YOUR_NEXA_API_KEY"
```

- `200` — at least one provider is reachable and has a routable model.
- `401` — the key is missing, unknown, or revoked.
- `503` — the key is valid but nothing can serve; the body names the reason.
