/**
 * Phase 5.8 — cross-tenant document disclosure via RAG retrieval.
 *
 * `RAGRetriever.retrieveRelevantChunks` used to take a caller-supplied
 * `documentIds` list verbatim and skip the `userId` / `projectId` ownership
 * filter entirely, then read every chunk belonging to those document ids.
 *
 * `/api/chat` is the reachable path: `attachments[].id` comes straight from the
 * request body, unvalidated, and is forwarded as `documentIds`; the retrieved
 * chunks are then streamed back to the caller.
 *
 * The property under test is behavioural and database-level: the *documents*
 * query is always scoped to the caller's own rows, so a foreign document id
 * resolves to nothing and the chunk query is never reached with it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const ALICE = "usr_alice";
const BOB = "usr_bob";

/** Documents that exist, with their owner. */
let rows: Array<{ id: string; userId: string; name: string; projectId: string | null }> = [];

/** Chunks that exist, keyed by document. */
let chunks: Array<{ documentId: string; content: string; chunkIndex: number }> = [];

/** Every documents/chunk query actually issued, so the filter is observable. */
let docQueries: unknown[][] = [];
let chunkQueries: unknown[][] = [];

/**
 * The condition builders are mocked too, so the test evaluates the *query the
 * code actually builds* rather than its intent. A missing ownership condition
 * therefore returns the foreign row, exactly as Postgres would.
 */
vi.mock("drizzle-orm", () => ({
  and: (...conds: unknown[]) => ({ conds }),
  eq: (col: unknown, val: unknown) => ({ col, op: "eq", val }),
  inArray: (col: unknown, val: unknown) => ({ col, op: "in", val }),
  asc: (col: unknown) => ({ col }),
  desc: (col: unknown) => ({ col }),
  and_: undefined,
}));

/**
 * A deliberately faithful stand-in for the Drizzle chain: it evaluates the
 * conditions that `eq` / `inArray` / `and` produce, so a missing ownership
 * condition yields a row — exactly as Postgres would.
 */
vi.mock("@/db", () => {
  const matches = (row: Record<string, unknown>, conds: unknown): boolean => {
    for (const c of conds as Array<{ col: string; op: string; val: unknown }>) {
      if (c.op === "eq" && row[c.col] !== c.val) return false;
      if (c.op === "in" && !(c.val as unknown[]).includes(row[c.col])) return false;
    }
    return true;
  };
  return {
    db: {
      select: (fields?: Record<string, string>) => ({
        from: (table: { __name: string }) => {
          const where = (conds?: unknown) => {
            // Accept a bare condition (`inArray(...)`) as well as an `and(...)`
            // group, because the chunk query uses the former.
            const list: unknown[] =
              conds == null
                ? []
                : Array.isArray(conds)
                  ? conds
                  : ((conds as { conds?: unknown[] }).conds ?? [conds]);
            let cached: unknown[] | undefined;
            const run = (n?: number) => {
              if (cached === undefined) {
                if (table.__name === "documents") {
                  docQueries.push(list);
                  cached = rows
                    .filter((r) => matches(r as Record<string, unknown>, list))
                    .map((r) => (fields ? { id: r.id, name: r.name } : r));
                } else {
                  chunkQueries.push(list);
                  cached = chunks.filter((r) => matches(r as Record<string, unknown>, list));
                }
              }
              return n === undefined ? cached : cached.slice(0, n);
            };
            // A Drizzle `where(...)` is both awaitable and chainable, so the
            // stand-in has to be too — and it must evaluate once, not once per
            // chain step.
            return {
              then: (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) =>
                Promise.resolve().then(() => run()).then(onOk, onErr),
              limit: (n: number) => Promise.resolve().then(() => run(n)),
            };
          };
          return { where };
        },
      }),
    },
  };
});

vi.mock("@/db/schema", () => ({
  documents: { __name: "documents", id: "id", userId: "userId", projectId: "projectId", name: "name" },
  documentChunks: {
    __name: "documentChunks",
    id: "id",
    documentId: "documentId",
    chunkIndex: "chunkIndex",
    content: "content",
    embedding: "embedding",
    metadata: "metadata",
  },
}));

/** Local, deterministic embedding so scoring is reproducible. */
vi.mock("@/lib/rag/embeddings", () => ({
  LocalEmbeddingService: { generateEmbedding: () => [0.1, 0.2, 0.3] },
}));

const { RAGRetriever } = await import("@/lib/rag/retriever");

beforeEach(() => {
  rows = [
    { id: "doc_alice_1", userId: ALICE, name: "Alice private notes", projectId: null },
    { id: "doc_bob_1", userId: BOB, name: "Bob confidential merger", projectId: null },
  ];
  chunks = [
    { documentId: "doc_alice_1", content: "alice secret content", chunkIndex: 0 },
    { documentId: "doc_bob_1", content: "BOB CONFIDENTIAL MERGER TERMS", chunkIndex: 0 },

  ];
  docQueries = [];
  chunkQueries = [];
});

const run = (opts: Record<string, unknown>) =>
  RAGRetriever.retrieveRelevantChunks("merger terms", {
    topK: 5,
    minScore: 0.0,
    ...opts,
  } as never);
describe("cross-tenant retrieval is blocked", () => {
  it("returns nothing when naming another user's document id", async () => {
    const out = await run({ userId: ALICE, documentIds: ["doc_bob_1"] });
    expect(out).toEqual([]);
  });

  it("never leaks the foreign document's text", async () => {
    const out = await run({ userId: ALICE, documentIds: ["doc_bob_1"] });
    expect(JSON.stringify(out)).not.toContain("CONFIDENTIAL");
  });

  it("does not read chunks belonging to the foreign document", async () => {
    await run({ userId: ALICE, documentIds: ["doc_bob_1"] });
    // The ownership filter must empty the id list before the chunk query runs.
    expect(docQueries).toHaveLength(1);
    expect(chunkQueries).toHaveLength(0);
  });

  it("honours only the caller's own id from a mixed list", async () => {
    // The filter is an AND, so a foreign id simply fails to match rather than
    // poisoning the whole request. Alice keeps her own document and learns
    // nothing about Bob's.
    const out = await run({ userId: ALICE, documentIds: ["doc_alice_1", "doc_bob_1"] });
    const text = JSON.stringify(out);
    expect(text).not.toContain("CONFIDENTIAL");
    expect(out.length).toBeGreaterThan(0);
    for (const chunk of out) {
      expect(chunk).toMatchObject({ documentId: "doc_alice_1" });
    }
  });

  it("blocks the reverse direction too", async () => {
    const out = await run({ userId: BOB, documentIds: ["doc_alice_1"] });
    expect(out).toEqual([]);
  });

  it("always applies the owner condition to the documents query", async () => {
    await run({ userId: ALICE, documentIds: ["doc_bob_1"] });
    const conds = docQueries[0] as Array<{ op: string; val: unknown }>;
    expect(conds.some((c) => c.op === "eq" && c.val === ALICE)).toBe(true);
  });
});

describe("legitimate retrieval still works", () => {
  it("returns the caller's own document when named", async () => {
    const out = await run({ userId: ALICE, documentIds: ["doc_alice_1"] });
    expect(out.length).toBeGreaterThan(0);
    expect(JSON.stringify(out)).toContain("alice secret content");
  });

  it("still resolves all own documents when no ids are supplied", async () => {
    const out = await run({ userId: ALICE });
    expect(out.length).toBeGreaterThan(0);
    expect(JSON.stringify(out)).not.toContain("CONFIDENTIAL");
  });

  it("ignores unknown ids rather than failing", async () => {
    const out = await run({ userId: ALICE, documentIds: ["doc_does_not_exist"] });
    expect(out).toEqual([]);
  });

  it("tolerates non-string entries in the id list", async () => {
    const out = await run({ userId: ALICE, documentIds: [null, 42, {}, "doc_alice_1"] });
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("fails closed without an owner identity", () => {
  it("returns nothing when userId is absent", async () => {
    const out = await run({ documentIds: ["doc_bob_1"] });
    expect(out).toEqual([]);
  });

  it("issues no database query at all without an owner identity", async () => {
    await run({ documentIds: ["doc_bob_1"] });
    expect(docQueries).toHaveLength(0);
    expect(chunkQueries).toHaveLength(0);
  });
});

