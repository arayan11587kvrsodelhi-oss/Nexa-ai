/**
 * Tenant isolation — a *behavioural* test.
 *
 * The Phase 5.3 suite proves the authenticated id reaches `ToolExecutor`. That
 * is an argument assertion, not proof: the original defect was precisely a
 * missing argument, and a test that only watched the argument would not have
 * caught the resulting data exposure.
 *
 * This suite runs the **real** `ToolExecutor` against a database double that
 * models PostgreSQL's actual semantics — `WHERE` filters rows, and no
 * ownership predicate means *every* row — and asserts on the **rows returned**.
 * If the ownership predicate is ever dropped, another tenant's document appears
 * in the result and the test fails.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/** Two tenants' documents. `rawContent` is what `file_search` matches on. */
const DOCUMENTS = [
  { id: "doc_a", userId: "usr_alice", name: "alice-report.txt", rawContent: "quarterly figures" },
  { id: "doc_b", userId: "usr_bob", name: "bob-secret.txt", rawContent: "quarterly figures" },
];

const dialect = new PgDialect();

/** Every value the query bound as a parameter, in order. */
function boundParams(condition: unknown): unknown[] {
  if (!condition) return [];
  try {
    return dialect.sqlToQuery(condition as SQL).params;
  } catch {
    return [];
  }
}

/** The SQL text the query generates, so we can assert on its shape. */
function referencedSql(condition: unknown): string {
  if (!condition) return "";
  try {
    return dialect.sqlToQuery(condition as SQL).sql;
  } catch {
    return "";
  }
}

/**
 * Models the database honestly: a row is returned only if every bound
 * predicate it can see is satisfied. With no ownership predicate bound, every
 * row comes back — which is exactly the bug being guarded against.
 */
function rowsMatching(condition: unknown): typeof DOCUMENTS {
  const params = boundParams(condition);
  const owner = params.find((p) => p === "usr_alice" || p === "usr_bob");
  const docId = params.find((p) => typeof p === "string" && p.startsWith("doc_"));

  let rows = DOCUMENTS;
  if (owner) rows = rows.filter((d) => d.userId === owner);
  if (docId) rows = rows.filter((d) => d.id === docId);
  return rows;
}

const selectWhere = vi.fn((condition: unknown) => ({
  limit: async (n: number) => rowsMatching(condition).slice(0, n),
}));

vi.mock("@/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: selectWhere }) }),
    insert: () => ({ values: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));
vi.mock("@/db/schema", () => ({
  documents: {
    id: "id",
    userId: "user_id",
    name: "name",
    rawContent: "raw_content",
    mimeType: "mime",
    size: "size",
    characterCount: "cc",
    chunkCount: "chunks",
  },
  documentChunks: { name: "document_chunks" },
}));

const { ToolExecutor } = await import("@/lib/tools/executor");

beforeEach(() => {
  selectWhere.mockClear();
});

describe("tenant isolation — file_search returns only the caller's documents", () => {
  it("does not return another user's document through the agent path", async () => {
    // The agent calls this with the session's id as the 4th argument.
    const result = await ToolExecutor.execute(
      "file_search",
      { query: "quarterly" },
      undefined,
      "usr_alice"
    );
    const ids = (result.result as { matches: Array<{ id: string }> }).matches.map((m) => m.id);
    expect(ids).toContain("doc_a");
    // The behavioural assertion: Bob's document must not be present.
    expect(ids).not.toContain("doc_b");
  });

  it("returns a different document set for a different user", async () => {
    const bob = await ToolExecutor.execute(
      "file_search",
      { query: "quarterly" },
      undefined,
      "usr_bob"
    );
    const ids = (bob.result as { matches: Array<{ id: string }> }).matches.map((m) => m.id);
    expect(ids).toEqual(["doc_b"]);
    expect(ids).not.toContain("doc_a");
  });

  it("binds the ownership predicate as a parameter, not interpolated text", async () => {
    await ToolExecutor.execute("file_search", { query: "quarterly" }, undefined, "usr_alice");
    const condition = selectWhere.mock.calls[0]?.[0];
    // The caller's id must be bound as a parameter. That is the property that
    // matters: a bound value cannot be widened by a crafted search term.
    expect(boundParams(condition)).toContain("usr_alice");
  });

  it("returns nothing rather than everything when no owner is supplied", async () => {
    // Defence in depth: the route always supplies an owner, but if one is
    // ever missing the result must be empty, not every tenant's documents.
    const result = await ToolExecutor.execute("file_search", { query: "quarterly" });
    const matches = (result.result as { matches: Array<{ id: string }> }).matches;
    expect(matches).toHaveLength(0);
  });
});

describe("tenant isolation — document_reader", () => {
  it("does not read another user's document content", async () => {
    const result = await ToolExecutor.execute(
      "document_reader",
      { documentId: "doc_b" },
      undefined,
      "usr_alice"
    );
    // Alice asking for Bob's document must be refused, not served.
    expect(JSON.stringify(result.result)).toMatch(/not found/i);
  });
});

describe("file_search pattern safety reaches the query, not just the helper", () => {
  it("does not let a bare % match every document", async () => {
    // With the pattern escaped, `%` is a literal percent sign. The assertion
    // is on the value actually bound into the query.
    await ToolExecutor.execute("file_search", { query: "%" }, undefined, "usr_alice");
    const params = boundParams(selectWhere.mock.calls[0]?.[0]);
    const pattern = params.find((p) => typeof p === "string" && p.includes("%"));
    expect(pattern).toBeDefined();
    expect(String(pattern)).toMatch(/\\%/);
  });
});
