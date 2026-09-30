/**
 * Phase 5.5 — conversation title search pattern safety.
 *
 * Phase 5.4 fixed the same defect in `file_search` and explicitly left
 * `GET /api/conversations?q=` alone. This suite covers that remaining site.
 *
 * The query is inspected the way a database would see it: the pattern that
 * actually reaches SQL is evaluated with real ILIKE semantics, so a wildcard
 * that survived escaping would show up as an over-broad result set.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * One tenant's conversations, plus another tenant's that must never appear.
 *
 * `createdAt`/`updatedAt` are Dates because the route calls `.toISOString()`
 * on them when shaping the response; a plain string here would make the route
 * throw and mask the behaviour under test.
 */
const NOW = new Date("2026-01-01T00:00:00.000Z");
const CONVERSATIONS = [
  {
    id: "c_a1",
    userId: "usr_alice",
    title: "quarterly report",
    isArchived: false,
    isPinned: false,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: "c_a2",
    userId: "usr_alice",
    title: "100% complete",
    isArchived: false,
    isPinned: false,
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    id: "c_b1",
    userId: "usr_bob",
    title: "quarterly report",
    isArchived: false,
    isPinned: false,
    createdAt: NOW,
    updatedAt: NOW,
  },
];

const dialect = new PgDialect();

function boundParams(condition: unknown): unknown[] {
  if (!condition) return [];
  try {
    return dialect.sqlToQuery(condition as SQL).params;
  } catch {
    return [];
  }
}

function sqlText(condition: unknown): string {
  try {
    return dialect.sqlToQuery(condition as SQL).sql;
  } catch {
    return "";
  }
}

/**
 * The ILIKE semantics that matter here: `%` = any run, `_` = any single
 * character, and `\x` = a literal `x` — that last one is what the ESCAPE clause
 * buys us, so a double that ignored it would be testing nothing.
 */
function ilike(value: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      re += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
      continue;
    }
    if (ch === "%") re += ".*";
    else if (ch === "_") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(value);
}

let seenLimit = 0;

/** The rows the query would return, evaluated the way PostgreSQL would. */
function rowsFor(condition: unknown) {
  const params = boundParams(condition);
  const owner = params.find((p) => p === "usr_alice" || p === "usr_bob");
  const pattern = params.find((p) => typeof p === "string" && p.startsWith("%"));
  const archived = params.find((p) => p === false);

  let rows = CONVERSATIONS;
  // Ownership first: only a parameterised owner predicate narrows the set.
  if (owner) rows = rows.filter((r) => r.userId === owner);
  if (pattern && typeof pattern === "string") {
    rows = rows.filter((r) => ilike(r.title, pattern));
  }
  if (archived === false) rows = rows.filter((r) => r.isArchived === false);
  return rows;
}

/**
 * The route issues two queries: the conversation list (chained with
 * `.orderBy().limit()`) and a per-conversation message count that is simply
 * awaited. Both shapes are served from here.
 */
const selectWhere = vi.fn((condition: unknown) => {
  const awaited = Promise.resolve(rowsFor(condition).map((r) => ({ id: r.id })));
  return Object.assign(awaited, {
    orderBy: () => ({
      limit: async (n: number) => {
        seenLimit = n;
        return rowsFor(condition).slice(0, n);
      },
    }),
  });
});

vi.mock("@/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: selectWhere }) }),
    insert: () => ({ values: vi.fn() }),
    update: () => ({ set: () => ({ where: vi.fn() }) }),
    delete: () => ({ where: vi.fn() }),
  },
}));
vi.mock("@/db/schema", () => ({
  conversations: {
    id: "id",
    userId: "user_id",
    title: "title",
    isArchived: "is_archived",
    isPinned: "is_pinned",
    updatedAt: "updated_at",
  },
  messages: { name: "messages" },
  projects: { id: "id", userId: "user_id" },
  tools: { name: "tools" },
}));

const ALICE = "usr_alice";
let sessionUser: string | null = ALICE;
vi.mock("@/lib/auth/guard", () => ({
  requireUser: async () => {
    if (!sessionUser) {
      const { ApiError } = await import("@/lib/api/errors");
      throw ApiError.unauthorized();
    }
    return { id: sessionUser, email: "u@nexa.invalid", name: null };
  },
}));

const { GET } = await import("@/app/api/conversations/route");

function get(search: string): NextRequest {
  return new NextRequest(`http://localhost/api/conversations${search}`);
}

async function titles(search: string): Promise<string[]> {
  const res = await GET(get(search));
  const body = (await res.json()) as { conversations: Array<{ title: string }> };
  return body.conversations.map((c) => c.title);
}

beforeEach(() => {
  selectWhere.mockClear();
  seenLimit = 0;
  sessionUser = ALICE;
});

describe("conversation search — wildcard terms are literal", () => {
  it("treats a bare % as a literal percent sign, not match-everything", async () => {
    // Before the fix this returned every conversation the user owns.
    expect(await titles("?q=%25")).toEqual(["100% complete"]);
  });

  it("finds a term containing a literal percent sign", async () => {
    expect(await titles("?q=100%25")).toEqual(["100% complete"]);
  });

  it("treats _ as a literal underscore, not a single-character wildcard", async () => {
    // `q_arterly` would previously have matched "quarterly report" via `_`.
    expect(await titles("?q=q_arterly")).toEqual([]);
  });

  it("matches a normal term exactly as before", async () => {
    expect(await titles("?q=quarterly")).toEqual(["quarterly report"]);
  });

  it("returns everything for an absent query, as it always did", async () => {
    // No `q` at all means no search predicate — unchanged behaviour.
    expect((await titles("")).length).toBe(2);
  });

  it("survives a lone backslash without producing an invalid pattern", async () => {
    // Escaping the escape character first keeps the pattern well-formed.
    expect((await GET(get("?q=%5C"))).status).toBe(200);
  });
});

describe("conversation search — tenant isolation is preserved", () => {
  it("never returns another user's conversations", async () => {
    const res = await GET(get("?q=quarterly"));
    const body = (await res.json()) as { conversations: Array<{ userId?: string }> };
    // Bob has a conversation with an identical title; only Alice's is returned.
    expect(body.conversations).toHaveLength(1);
  });

  it("keeps the ownership predicate in the generated SQL", async () => {
    await GET(get("?q=quarterly"));
    const condition = selectWhere.mock.calls[0]?.[0];
    // The caller's id must be a bound parameter on the query. The column name
    // is not asserted because the schema is doubled here, so only the value is
    // observable — and the value is what the isolation actually depends on.
    expect(boundParams(condition)).toContain(ALICE);
  });

  it("binds the search term as a parameter, never concatenates it into SQL", async () => {
    await GET(get("?q=quarterly"));
    const condition = selectWhere.mock.calls[0]?.[0];
    // The statement text holds only a placeholder; the value is a bound param.
    expect(boundParams(condition).some((p) => p === "%quarterly%")).toBe(true);
    expect(sqlText(condition)).not.toContain("quarterly");
  });

  it("preserves the result limit of 50", async () => {
    await GET(get("?q=quarterly"));
    expect(seenLimit).toBe(50);
  });

  it("requires authentication", async () => {
    sessionUser = null;
    expect((await GET(get("?q=quarterly"))).status).toBe(401);
  });
});

