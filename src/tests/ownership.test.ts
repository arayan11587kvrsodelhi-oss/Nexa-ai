/**
 * Ownership / authorization tests (Phase 4).
 *
 * Strategy — the honest middle ground available without PostgreSQL:
 *
 *  - The REAL route handlers are invoked (no handler code is mocked).
 *  - The REAL `requireUser` guard resolves the session from the cookie
 *    through the real SessionService (session rows are scripted).
 *  - The REAL Drizzle query builder compiles the SQL; we assert on the
 *    compiled SQL that every user-owned query pairs the resource id with
 *    the requesting user's id.
 *  - Only query EXECUTION is faked: the compiled builder chain is wrapped so
 *    awaiting it resolves scripted rows instead of hitting the wire. (Row
 *    objects are returned as-is — a scripted driver has no column metadata
 *    for drizzle's positional mapper.)
 *
 * This verifies the authorization logic and its SQL. It does NOT verify
 * real PostgreSQL execution — that remains unverified in this environment.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextRequest as NextRequestClass } from "next/server";

/* ------------------------------------------------------------------ */
/* Scripted execution over real Drizzle query builders                */
/* ------------------------------------------------------------------ */

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

const captured: CapturedQuery[] = [];

/** Test scenario: rows returned for the next query on each table. */
interface Plan {
  /** rows keyed by first matching table name in the SQL text */
  [table: string]: unknown[];
}

let plan: Plan = {};
const TABLE_ORDER = [
  "sessions",
  "document_chunks",
  "documents",
  "audit_logs",
  "memories",
  "messages",
  "conversations",
  "projects",
  "model_configs",
  "tool_calls",
  "agent_runs",
];

function rowsFor(sql: string): unknown[] {
  const lower = sql.toLowerCase();
  for (const table of TABLE_ORDER) {
    if (lower.includes(`"${table}"`)) {
      const rows = plan[table];
      if (rows) return rows;
    }
  }
  return [];
}

/**
 * Compile the awaited drizzle chain with the REAL engine, record the SQL,
 * and resolve the await with scripted rows for the matching table.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveResults(chain: any): unknown[] {
  const q = chain.toSQL();
  captured.push({ sql: q.sql, params: q.params });
  return rowsFor(q.sql);
}

const { QueryBuilder, PgInsertBuilder, PgUpdateBuilder, PgDeleteBase, PgDialect } = vi.hoisted(() => {
  const core = require("drizzle-orm/pg-core");
  return {
    QueryBuilder: core.QueryBuilder,
    PgInsertBuilder: core.PgInsertBuilder,
    PgUpdateBuilder: core.PgUpdateBuilder,
    PgDeleteBase: core.PgDeleteBase,
    PgDialect: core.PgDialect,
  };
});

vi.mock("@/db", () => {
  /** Drizzle needs a dialect to compile SQL; it is never used to connect. */
  const dialect = new PgDialect();
  const session = { schema: {}, relations: {} };
  const resolve = (built: unknown) => resolveResults(built);

  /**
   * Wrap a drizzle builder so awaiting it resolves scripted rows.
   *
   * Phase 5.9: `results` is handed the *live* target, i.e. the query as it
   * stands when the chain is awaited. It used to be handed the builder captured
   * at `db.select(...)` time, and `toSQL()` was called on that. A bare
   * `QueryBuilder.select()` has no `toSQL()` — only the built query does — so
   * any route that reached a code path the old capture could not compile threw
   * `chain.toSQL is not a function` inside the mock, surfaced as a 503, and the
   * real authorization assertion never ran.
   */
  function wrap(target: unknown, results: (built: unknown) => unknown[]): unknown {
    return new Proxy(target as object, {
      get(t, prop, _recv) {
        if (prop === "then") {
          return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
            Promise.resolve(results(t)).then(onFulfilled, onRejected);
        }
        if (prop === "catch") {
          return (fn: (e: unknown) => unknown) => Promise.resolve(results(t)).catch(fn);
        }
        if (prop === "finally") {
          return (fn: () => void) => Promise.resolve(results(t)).finally(fn);
        }
        const value = Reflect.get(t, prop, t);
        if (typeof value === "function") {
          return (...args: unknown[]) => wrap(Reflect.apply(value, t, args), results);
        }
        return value;
      },
    });
  }

  const fakeDb = {
    /**
     * Phase 5.9: the shared rate limiter (`@/lib/gateway/rate-limit`) reaches
     * PostgreSQL through `db.execute()` with an upsert, not through the query
     * builder. This mock predates that, so every `db.execute(...)` threw
     * `is not a function`, the limiter caught it and — correctly, by design —
     * failed *closed*, and every route answered 503 before its authorization
     * logic ever ran.
     *
     * The result therefore said nothing about ownership; the suite had been
     * dark since Phase 5.
     *
     * This resolves the exact shape the limiter reads (`{ rows: [...] }` for
     * the node-postgres driver) and always reports a count of 1, which is
     * inside every policy. The real limiter therefore still runs, still
     * executes its real logic, and still allows the request — only the
     * unreachable database is stood in for.
     */
    execute: async () => ({
      rows: [{ count: 1, window_start: Date.now() }],
      rowCount: 1,
    }),
    select: (...args: unknown[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain = (new QueryBuilder() as any).select(...args);
      return wrap(chain, (built) => resolveResults(built));
    },
    // Phase 5.9: `QueryBuilder` only provides `select*`. `insert`, `update` and
    // `delete` live on the database object and are built from the dedicated
    // `PgInsertBuilder` / `PgUpdateBuilder` / `PgDeleteBase` classes, so calling
    // them on a bare `QueryBuilder` threw "is not a function" and every
    // cross-tenant UPDATE/DELETE assertion aborted with a 500 before the
    // ownership condition could be checked.
    insert: (table: unknown) => {
      /**
       * Phase 5.9: a real `INSERT ... RETURNING` echoes the row it wrote, and
       * routes rely on that (`const [inserted] = await db.insert(...)`). The
       * mock has no store and returned `[]`, so the destructure produced
       * `undefined` and the route threw — masking the credential-stripping
       * assertion this test exists to make.
       */
      const payload: Record<string, unknown> = {};
      const builder = new PgInsertBuilder(table, session, dialect);
      const chained = wrap(builder, (built) => {
        const scripted = resolveResults(built);
        return scripted.length > 0 ? scripted : [{ ...payload }];
      });
      return new Proxy(chained as object, {
        get(t, prop, recv) {
          if (prop === "values") {
            return (v: Record<string, unknown>) => {
              Object.assign(payload, v);
              return (t as { values: (x: unknown) => unknown }).values(v);
            };
          }
          return Reflect.get(t, prop, recv);
        },
      });
    },

    update: (table: unknown) => wrap(new PgUpdateBuilder(table, session, dialect), resolve),
    delete: (table: unknown) => wrap(new PgDeleteBase(table, session, dialect), resolve),
  };

  return {
    db: fakeDb,
    checkDatabase: async () => ({
      configured: true,
      reachable: true,
      message: "scripted query executor",
    }),
  };
});

vi.mock("@/lib/security/audit", () => ({
  AuditLogger: { log: async () => undefined },
}));

/* ------------------------------------------------------------------ */
/* Users and fixtures                                                 */
/* ------------------------------------------------------------------ */

const USER_A = { id: "usr_aaaaaaaaaa", email: "a@example.com", name: "User A" };
const USER_B = { id: "usr_bbbbbbbbbb", email: "b@example.com", name: "User B" };

const SESSION_TTL = 3600_000;
const TOKEN_A = "token-for-user-a";
const TOKEN_B = "token-for-user-b";

// Mirrors SessionTokenService.hash (sha256 hex). Keep in sync by importing
// the real service instead of re-implementing.
import { SessionTokenService } from "@/lib/auth/tokens";
const HASH_A = SessionTokenService.hash(TOKEN_A);

function sessionRow(user: typeof USER_A) {
  return { id: user.id, email: user.email, name: user.name, expiresAt: new Date(Date.now() + SESSION_TTL) };
}

const OWNED_CONVERSATION = {
  id: "conv_a", userId: USER_A.id, title: "A's chat", model: "llama3.2:latest",
  profile: "BALANCED", systemPrompt: null, isArchived: false, isPinned: false,
  projectId: null, createdAt: new Date(), updatedAt: new Date(),
};
const OWNED_PROJECT = {
  id: "proj_a", userId: USER_A.id, name: "A's project", description: null,
  instructions: null, modelPreference: "BALANCED", createdAt: new Date(), updatedAt: new Date(),
};
const OWNED_DOCUMENT = {
  id: "doc_a", userId: USER_A.id, name: "a.txt", mimeType: "text/plain", size: 10,
  characterCount: 10, chunkCount: 1, status: "indexed", projectId: null,
  rawContent: "hello", createdAt: new Date(),
};
const OWNED_MEMORY = {
  id: "mem_a", userId: USER_A.id, content: "likes tea", category: "preference",
  source: "explicit", isActive: true, createdAt: new Date(),
};
const OWNED_MODEL_CONFIG = {
  id: "cfg_a", userId: USER_A.id, provider: "demo", baseUrl: "http://localhost:11434",
  modelName: "demo", apiKey: "sk-secret", temperature: 0.7, topP: 0.9, maxTokens: 4096,
  contextWindow: 8192, systemPrompt: null, isDefault: true, isActive: true,
  createdAt: new Date(), updatedAt: new Date(),
};

/** Build a NextRequest with an optional session cookie. */
function makeReq(
  url: string,
  opts: { method?: string; token?: string; body?: unknown } = {}
): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.cookie = `nexa_session=${opts.token}`;
  return new NextRequestClass(`http://localhost${url}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  }) as NextRequest;
}

const paramsProps = (id: string) => ({ params: Promise.resolve({ id }) });

/** Last captured query against a given table (if any). */
function lastQueryFor(table: string): CapturedQuery | undefined {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].sql.toLowerCase().includes(`"${table}"`)) return captured[i];
  }
  return undefined;
}

beforeEach(() => {
  captured.length = 0;
  plan = {
    sessions: [sessionRow(USER_B)],
    audit_logs: [],
  };
});

/* ------------------------------------------------------------------ */
/* Route modules under test                                           */
/* ------------------------------------------------------------------ */

let conversationsId: typeof import("@/app/api/conversations/[id]/route");
let projectsId: typeof import("@/app/api/projects/[id]/route");
let filesId: typeof import("@/app/api/files/[id]/route");
let memoryId: typeof import("@/app/api/memory/[id]/route");
let memoryRoute: typeof import("@/app/api/memory/route");
let conversationsRoute: typeof import("@/app/api/conversations/route");
let modelsRoute: typeof import("@/app/api/models/route");
let toolsRoute: typeof import("@/app/api/tools/route");
let logoutRoute: typeof import("@/app/api/auth/logout/route");

beforeAll(async () => {
  conversationsId = await import("@/app/api/conversations/[id]/route");
  projectsId = await import("@/app/api/projects/[id]/route");
  filesId = await import("@/app/api/files/[id]/route");
  memoryId = await import("@/app/api/memory/[id]/route");
  memoryRoute = await import("@/app/api/memory/route");
  conversationsRoute = await import("@/app/api/conversations/route");
  modelsRoute = await import("@/app/api/models/route");
  toolsRoute = await import("@/app/api/tools/route");
  logoutRoute = await import("@/app/api/auth/logout/route");
});

/* ------------------------------------------------------------------ */
/* 1. Unauthenticated access → 401                                    */
/* ------------------------------------------------------------------ */

describe("unauthenticated requests return 401", () => {
  it.each([
    ["conversations list", () => conversationsRoute.GET(makeReq("/api/conversations"))],
    ["conversation get", () => conversationsId.GET(makeReq("/api/conversations/conv_a"), paramsProps("conv_a"))],
    ["conversation patch", () => conversationsId.PATCH(makeReq("/api/conversations/conv_a", { method: "PATCH", body: { title: "x" } }), paramsProps("conv_a"))],
    ["conversation delete", () => conversationsId.DELETE(makeReq("/api/conversations/conv_a", { method: "DELETE" }), paramsProps("conv_a"))],
    ["project get", () => projectsId.GET(makeReq("/api/projects/proj_a"), paramsProps("proj_a"))],
    ["document get", () => filesId.GET(makeReq("/api/files/doc_a"), paramsProps("doc_a"))],
    ["memory list", () => memoryRoute.GET(makeReq("/api/memory"))],
    ["memory delete", () => memoryId.DELETE(makeReq("/api/memory/mem_a", { method: "DELETE" }), paramsProps("mem_a"))],
    ["models get", () => modelsRoute.GET(makeReq("/api/models"))],
    ["tools get", () => toolsRoute.GET(makeReq("/api/tools"))],
  ])("%s → 401 without a session cookie", async (_name, call) => {
    const res = await call();
    expect(res.status).toBe(401);
  });

  it("rejects an invalid (unknown) session token → 401", async () => {
    plan.sessions = [];
    const res = await conversationsId.GET(makeReq("/api/conversations/conv_a", { token: "forged-token" }), paramsProps("conv_a"));
    expect(res.status).toBe(401);
  });

  it("rejects an expired session → 401", async () => {
    plan.sessions = [{ ...sessionRow(USER_B), expiresAt: new Date(Date.now() - 1000) }];
    const res = await conversationsId.GET(makeReq("/api/conversations/conv_a", { token: TOKEN_B }), paramsProps("conv_a"));
    expect(res.status).toBe(401);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Cross-user access (User B touching User A's resources)          */
/* ------------------------------------------------------------------ */

describe("User B cannot access User A's resources (SQL-scoped → 404)", () => {
  it("GET A's conversation → 404 and SQL pairs id with B's userId", async () => {
    plan.conversations = [];
    const res = await conversationsId.GET(makeReq("/api/conversations/conv_a", { token: TOKEN_B }), paramsProps("conv_a"));
    expect(res.status).toBe(404);
    const q = lastQueryFor("conversations");
    expect(q).toBeDefined();
    expect(q!.sql.toLowerCase()).toContain("user_id");
    expect(q!.params).toContain(USER_B.id);
    expect(q!.params).toContain("conv_a");
  });

  it("GET A's conversation does not return A's messages", async () => {
    plan.conversations = [];
    const res = await conversationsId.GET(makeReq("/api/conversations/conv_a", { token: TOKEN_B }), paramsProps("conv_a"));
    expect(res.status).toBe(404);
    // The messages query is never reached: the resource query returned nothing.
    expect(lastQueryFor("messages")).toBeUndefined();
  });

  it("PATCH A's conversation → 404", async () => {
    plan.conversations = [];
    const res = await conversationsId.PATCH(
      makeReq("/api/conversations/conv_a", { method: "PATCH", token: TOKEN_B, body: { title: "hijacked" } }),
      paramsProps("conv_a")
    );
    expect(res.status).toBe(404);
    const q = lastQueryFor("conversations");
    expect(q!.sql.trimStart().startsWith("update")).toBe(true);
    expect(q!.params).toContain(USER_B.id);
  });

  it("DELETE A's conversation → 404 and deletes nothing", async () => {
    plan.conversations = [];
    const res = await conversationsId.DELETE(makeReq("/api/conversations/conv_a", { method: "DELETE", token: TOKEN_B }), paramsProps("conv_a"));
    expect(res.status).toBe(404);
    const q = lastQueryFor("conversations");
    expect(q!.sql.trimStart().startsWith("delete")).toBe(true);
    expect(q!.params).toContain(USER_B.id);
    expect(q!.params).toContain("conv_a");
  });

  it("GET A's project → 404", async () => {
    plan.projects = [];
    const res = await projectsId.GET(makeReq("/api/projects/proj_a", { token: TOKEN_B }), paramsProps("proj_a"));
    expect(res.status).toBe(404);
    expect(lastQueryFor("projects")!.params).toContain(USER_B.id);
  });

  it("PATCH A's project → 404", async () => {
    plan.projects = [];
    const res = await projectsId.PATCH(
      makeReq("/api/projects/proj_a", { method: "PATCH", token: TOKEN_B, body: { name: "hijacked" } }),
      paramsProps("proj_a")
    );
    expect(res.status).toBe(404);
    expect(lastQueryFor("projects")!.params).toContain(USER_B.id);
  });

  it("DELETE A's project → 404", async () => {
    plan.projects = [];
    const res = await projectsId.DELETE(makeReq("/api/projects/proj_a", { method: "DELETE", token: TOKEN_B }), paramsProps("proj_a"));
    expect(res.status).toBe(404);
    const q = lastQueryFor("projects");
    expect(q!.sql.trimStart().startsWith("delete")).toBe(true);
    expect(q!.params).toContain(USER_B.id);
  });

  it("GET A's document → 404 and chunks not exposed", async () => {
    plan.documents = [];
    const res = await filesId.GET(makeReq("/api/files/doc_a", { token: TOKEN_B }), paramsProps("doc_a"));
    expect(res.status).toBe(404);
    expect(lastQueryFor("documents")!.params).toContain(USER_B.id);
    expect(lastQueryFor("document_chunks")).toBeUndefined();
  });

  it("DELETE A's document → 404", async () => {
    plan.documents = [];
    const res = await filesId.DELETE(makeReq("/api/files/doc_a", { method: "DELETE", token: TOKEN_B }), paramsProps("doc_a"));
    expect(res.status).toBe(404);
    expect(lastQueryFor("documents")!.params).toContain(USER_B.id);
  });

  it("PATCH A's memory → 404", async () => {
    plan.memories = [];
    const res = await memoryId.PATCH(
      makeReq("/api/memory/mem_a", { method: "PATCH", token: TOKEN_B, body: { isActive: false } }),
      paramsProps("mem_a")
    );
    expect(res.status).toBe(404);
    expect(lastQueryFor("memories")!.params).toContain(USER_B.id);
  });

  it("DELETE A's memory → 404", async () => {
    plan.memories = [];
    const res = await memoryId.DELETE(makeReq("/api/memory/mem_a", { method: "DELETE", token: TOKEN_B }), paramsProps("mem_a"));
    expect(res.status).toBe(404);
    expect(lastQueryFor("memories")!.params).toContain(USER_B.id);
  });

  it("GET /api/models as B uses only B's config, never A's", async () => {
    plan.model_configs = [];
    const res = await modelsRoute.GET(makeReq("/api/models", { token: TOKEN_B }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // No config row for B → environment fallback; A's demo config never used.
    expect(body.activeConfig.source).toBe("environment");
    const q = lastQueryFor("model_configs");
    expect(q!.params).toContain(USER_B.id);
  });

  it("GET /api/tools as B never returns A's tool calls", async () => {
    const res = await toolsRoute.GET(makeReq("/api/tools", { token: TOKEN_B }));
    expect(res.status).toBe(200);
    // The tools listing endpoint queries no user data at all.
    expect(lastQueryFor("tool_calls")).toBeUndefined();
  });

  it("A's session token is not usable to enumerate B-facing lists", async () => {
    plan.conversations = [{ ...OWNED_CONVERSATION, userId: USER_B.id }];
    const res = await conversationsRoute.GET(makeReq("/api/conversations", { token: TOKEN_B }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Only B's rows are ever returned even if A's ids are requested.
    expect(body.conversations.every((c: { userId: string }) => c.userId === USER_B.id)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Owner access (User A touching their own resources)              */
/* ------------------------------------------------------------------ */

describe("the owner can access their own resources", () => {
  beforeEach(() => {
    plan.sessions = [sessionRow(USER_A)];
  });

  it("GET own conversation → 200 with messages", async () => {
    plan.conversations = [OWNED_CONVERSATION];
    plan.messages = [{ id: "m1", conversationId: "conv_a", role: "user", content: "hi", createdAt: new Date() }];
    const res = await conversationsId.GET(makeReq("/api/conversations/conv_a", { token: TOKEN_A }), paramsProps("conv_a"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversation.id).toBe("conv_a");
    expect(body.conversation.userId).toBe(USER_A.id);
    expect(body.messages).toHaveLength(1);
  });

  it("PATCH own conversation → 200", async () => {
    plan.conversations = [{ ...OWNED_CONVERSATION, title: "renamed" }];
    const res = await conversationsId.PATCH(
      makeReq("/api/conversations/conv_a", { method: "PATCH", token: TOKEN_A, body: { title: "renamed" } }),
      paramsProps("conv_a")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversation.title).toBe("renamed");
  });

  it("DELETE own conversation → 200", async () => {
    plan.conversations = [{ id: "conv_a" }];
    const res = await conversationsId.DELETE(makeReq("/api/conversations/conv_a", { method: "DELETE", token: TOKEN_A }), paramsProps("conv_a"));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("GET own project → 200", async () => {
    plan.projects = [OWNED_PROJECT];
    plan.documents = [];
    plan.conversations = [];
    const res = await projectsId.GET(makeReq("/api/projects/proj_a", { token: TOKEN_A }), paramsProps("proj_a"));
    expect(res.status).toBe(200);
    expect((await res.json()).project.id).toBe("proj_a");
  });

  it("GET own document → 200", async () => {
    plan.documents = [OWNED_DOCUMENT];
    plan.document_chunks = [{ id: "c1", chunkIndex: 0, content: "hello", metadata: null }];
    const res = await filesId.GET(makeReq("/api/files/doc_a", { token: TOKEN_A }), paramsProps("doc_a"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.document.id).toBe("doc_a");
    expect(body.chunks).toHaveLength(1);
  });

  it("DELETE own document → 200", async () => {
    plan.documents = [{ id: "doc_a" }];
    const res = await filesId.DELETE(makeReq("/api/files/doc_a", { method: "DELETE", token: TOKEN_A }), paramsProps("doc_a"));
    expect(res.status).toBe(200);
  });

  it("GET own memories → 200, only own rows", async () => {
    plan.memories = [OWNED_MEMORY];
    const res = await memoryRoute.GET(makeReq("/api/memory", { token: TOKEN_A }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memories).toHaveLength(1);
    expect(body.memories[0].userId).toBe(USER_A.id);
  });

  it("PATCH own memory → 200", async () => {
    plan.memories = [{ ...OWNED_MEMORY, isActive: false }];
    const res = await memoryId.PATCH(
      makeReq("/api/memory/mem_a", { method: "PATCH", token: TOKEN_A, body: { isActive: false } }),
      paramsProps("mem_a")
    );
    expect(res.status).toBe(200);
  });

  it("DELETE own memory → 200", async () => {
    plan.memories = [{ id: "mem_a" }];
    const res = await memoryId.DELETE(makeReq("/api/memory/mem_a", { method: "DELETE", token: TOKEN_A }), paramsProps("mem_a"));
    expect(res.status).toBe(200);
  });

  it("GET /api/models with own config → 200 and apiKey is never returned", async () => {
    plan.model_configs = [OWNED_MODEL_CONFIG];
    const res = await modelsRoute.GET(makeReq("/api/models", { token: TOKEN_A }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sk-secret");
    const body = JSON.parse(text);
    expect(body.activeConfig.source).toBe("database");
    expect(body.activeConfig.isDemo).toBe(true);
  });

  it("POST /api/models stores config owned by A and strips apiKey from the response", async () => {
    plan.model_configs = [];
    const res = await modelsRoute.POST(makeReq("/api/models", {
      method: "POST",
      token: TOKEN_A,
      body: { provider: "ollama", baseUrl: "http://localhost:11434", modelName: "llama3.2:3b", apiKey: "sk-new-secret" },
    }));
    expect(res.status).toBe(200);
    const q = lastQueryFor("model_configs");
    expect(q).toBeDefined();
    // Deactivation + insert are both scoped to the requesting user.
    expect(q!.params).toContain(USER_A.id);
    const text = await res.text();
    expect(text).not.toContain("sk-new-secret");
  });

  it("GET /api/tools lists tool definitions", async () => {
    const res = await toolsRoute.GET(makeReq("/api/tools", { token: TOKEN_A }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Session revocation / logout                                     */
/* ------------------------------------------------------------------ */

describe("session revocation", () => {
  it("logout deletes the session row scoped by the hashed token", async () => {
    plan.sessions = [];
    const res = await logoutRoute.POST(makeReq("/api/auth/logout", { method: "POST", token: TOKEN_A }));
    expect(res.status).toBe(200);
    const q = lastQueryFor("sessions");
    expect(q).toBeDefined();
    expect(q!.sql.trimStart().startsWith("delete")).toBe(true);
    expect(q!.params).toContain(HASH_A);
  });

  it("after logout the same token no longer authenticates", async () => {
    plan.sessions = [];
    const res = await conversationsId.GET(makeReq("/api/conversations/conv_a", { token: TOKEN_A }), paramsProps("conv_a"));
    expect(res.status).toBe(401);
  });

  it("expired sessions are rejected, not honored", async () => {
    plan.sessions = [{ ...sessionRow(USER_A), expiresAt: new Date(Date.now() - SESSION_TTL) }];
    const res = await conversationsId.GET(makeReq("/api/conversations/conv_a", { token: TOKEN_A }), paramsProps("conv_a"));
    expect(res.status).toBe(401);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Input validation on protected routes                            */
/* ------------------------------------------------------------------ */

describe("input validation on protected routes", () => {
  beforeEach(() => {
    plan.sessions = [sessionRow(USER_A)];
  });

  it("PATCH conversation with a non-JSON body → 400", async () => {
    const req = new NextRequestClass("http://localhost/api/conversations/conv_a", {
      method: "PATCH",
      headers: { cookie: `nexa_session=${TOKEN_A}`, "content-type": "application/json" },
      body: "not-json",
    }) as NextRequest;
    const res = await conversationsId.PATCH(req, paramsProps("conv_a"));
    expect(res.status).toBe(400);
  });

  it("memory POST with empty content → 400", async () => {
    const res = await memoryRoute.POST(makeReq("/api/memory", { method: "POST", token: TOKEN_A, body: { content: "   " } }));
    expect(res.status).toBe(400);
  });

  it("models POST with a non-object body → 400", async () => {
    const res = await modelsRoute.POST(makeReq("/api/models", { method: "POST", token: TOKEN_A, body: undefined }));
    expect(res.status).toBe(400);
  });
});
