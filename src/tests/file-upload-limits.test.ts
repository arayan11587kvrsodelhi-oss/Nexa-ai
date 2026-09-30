/**
 * Phase 5.4 — file-upload throttling, LIKE-pattern safety, and cross-origin
 * state-change defence.
 *
 * Every finding here was verified against this checkout before anything was
 * changed:
 *
 *  - `POST /api/files` had no application-level limit while performing a
 *    per-chunk embedding pass and unbounded storage growth per upload.
 *  - `file_search` interpolated the search term raw into a LIKE pattern, so
 *    `%` and `_` acted as wildcards.
 *  - There was no Origin validation; the only CSRF defence was the cookie's
 *    `SameSite=Lax` attribute.
 *
 * The database is doubled so bucket arithmetic is real; the embedding,
 * chunking and audit services are the seams.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

interface Row {
  windowStart: number;
  count: number;
}

const rows = new Map<string, Row>();
let storeError: Error | null = null;

const execute = vi.fn(async (query: { queryChunks: unknown[] }) => {
  const params = (query.queryChunks as unknown[]).filter(
    (chunk) =>
      !(
        chunk !== null &&
        typeof chunk === "object" &&
        Array.isArray((chunk as { value?: unknown }).value)
      )
  );
  const bucketKey = String(params[0]);
  const start = Number(params[1]);
  if (storeError) throw storeError;
  const existing = rows.get(bucketKey);
  const stale = !existing || existing.windowStart < start;
  rows.set(bucketKey, {
    windowStart: stale ? start : existing.windowStart,
    count: stale ? 1 : existing.count + 1,
  });
  return {
    rows: [
      { count: rows.get(bucketKey)!.count, window_start: rows.get(bucketKey)!.windowStart },
    ],
  };
});

const inserted = vi.fn(async (..._args: unknown[]) => undefined);
const updated = vi.fn(async (..._args: unknown[]) => undefined);

/**
 * The insert mock is chainable because the route calls
 * `db.insert(t).values(row).returning()`, and must resolve to a document row —
 * the handler reads `newDoc.id` and `newDoc.createdAt` straight off it.
 */
const insertedDocument = {
  id: "doc_test",
  name: "notes.txt",
  size: 11,
  createdAt: new Date(0),
};

vi.mock("@/db", () => ({
  db: {
    execute: (q: { queryChunks: unknown[] }) => execute(q),
    insert: () => {
      const chain = {
        values: (...args: unknown[]) => {
          inserted(...args);
          return chain;
        },
        returning: async () => [insertedDocument],
      };
      return chain;
    },
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    update: () => ({ set: () => ({ where: updated }) }),
  },
}));
vi.mock("@/db/schema", () => ({
  documents: { id: "id", userId: "user_id", name: "name", rawContent: "raw_content" },
  documentChunks: { id: "id", documentId: "document_id" },
  projects: { id: "id", userId: "user_id" },
}));

const OWNER = "usr_owner";
const OTHER = "usr_other";

let sessionUser: string | null = OWNER;
vi.mock("@/lib/auth/guard", () => ({
  requireUser: async () => {
    if (!sessionUser) {
      const { ApiError } = await import("@/lib/api/errors");
      throw ApiError.unauthorized();
    }
    return { id: sessionUser, email: "u@nexa.invalid", name: null };
  },
}));

/** The expensive part of an upload: one embedding per chunk. */
const generateEmbedding = vi.fn((text: string) => [text.length, 0.5, 0.25, 0.125]);
vi.mock("@/lib/rag/embeddings", () => ({
  LocalEmbeddingService: { generateEmbedding: (t: string) => generateEmbedding(t) },
}));
vi.mock("@/lib/rag/chunker", () => ({
  DocumentChunker: {
    extractText: (_name: string, raw: string) => raw,
    chunkText: (raw: string) =>
      raw.length > 0
        ? Array.from({ length: Math.ceil(raw.length / 100) }, (_, i) => ({
            content: raw.slice(i * 100, i * 100 + 100),
            chunkIndex: i,
            tokens: 10,
            charStart: i * 100,
            charEnd: i * 100 + 100,
          }))
        : [],
  },
}));
vi.mock("@/lib/security/audit", () => ({ AuditLogger: { log: async () => undefined } }));

const { POST } = await import("@/app/api/files/route");
// Imported at module scope: `await` is not allowed inside a `describe` body.
const { sanitizeLikePattern } = await import("@/lib/tools/executor");
const middlewareModule = await import("@/middleware");
const middleware = middlewareModule.middleware;
const matcher = (middlewareModule as unknown as { config: { matcher: string[] } }).config.matcher;

const UPLOAD_LIMIT = 3;
const IP_LIMIT = 4;

function req(body: unknown, ip = "203.0.113.70"): NextRequest {
  return new NextRequest("http://localhost/api/files", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

const UPLOAD = { name: "notes.txt", content: "hello world", size: 11 };

beforeEach(() => {
  rows.clear();
  storeError = null;
  execute.mockClear();
  inserted.mockClear();
  updated.mockClear();
  generateEmbedding.mockClear();
  sessionUser = OWNER;
  vi.stubEnv("NEXA_FILE_UPLOAD_USER_RATE_LIMIT", String(UPLOAD_LIMIT));
  vi.stubEnv("NEXA_FILE_UPLOAD_IP_RATE_LIMIT", String(IP_LIMIT));
});

describe("POST /api/files — authentication ordering", () => {
  it("returns 401 and never touches the limiter without a session", async () => {
    sessionUser = null;
    const res = await POST(req(UPLOAD));
    expect(res.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("never converts an authentication failure into a throttle", async () => {
    sessionUser = null;
    const statuses: number[] = [];
    for (let i = 0; i < IP_LIMIT + 3; i++) statuses.push((await POST(req(UPLOAD))).status);
    expect(new Set(statuses)).toEqual(new Set([401]));
  });
});

describe("POST /api/files — upload quota", () => {
  it("serves uploads within the limit and answers 429 beyond it", async () => {
    for (let i = 0; i < UPLOAD_LIMIT; i++) {
      expect((await POST(req(UPLOAD))).status, `upload ${i}`).toBe(200);
    }
    expect((await POST(req(UPLOAD))).status).toBe(429);
  });

  it("performs no work at all when throttled", async () => {
    for (let i = 0; i < UPLOAD_LIMIT; i++) await POST(req(UPLOAD));
    const writes = inserted.mock.calls.length;
    const embeddings = generateEmbedding.mock.calls.length;
    const res = await POST(req(UPLOAD));
    // A refused upload must not chunk, embed, or write anything.
    expect(inserted.mock.calls.length).toBe(writes);
    expect(generateEmbedding.mock.calls.length).toBe(embeddings);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("reports Retry-After and the remaining quota without leaking internals", async () => {
    for (let i = 0; i < UPLOAD_LIMIT; i++) await POST(req(UPLOAD));
    const res = await POST(req(UPLOAD));
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(UPLOAD_LIMIT));
    const body = await res.text();
    expect(body).not.toMatch(/rate_limit_buckets|SELECT|INSERT|usr_owner|sql|stack/i);
  });

  it("isolates one user's exhausted quota from another's", async () => {
    for (let i = 0; i < UPLOAD_LIMIT; i++) await POST(req(UPLOAD));
    expect((await POST(req(UPLOAD))).status).toBe(429);
    sessionUser = OTHER;
    expect((await POST(req(UPLOAD, "198.51.100.12"))).status).toBe(200);
  });

  it("shares one address budget across users", async () => {
    vi.stubEnv("NEXA_FILE_UPLOAD_USER_RATE_LIMIT", "1000");
    for (let i = 0; i < IP_LIMIT; i++) {
      sessionUser = `usr_${i}`;
      expect((await POST(req(UPLOAD))).status, `user ${i}`).toBe(200);
    }
    sessionUser = "usr_new";
    const res = await POST(req(UPLOAD));
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(IP_LIMIT));
  });

  it("keeps different addresses independent", async () => {
    vi.stubEnv("NEXA_FILE_UPLOAD_USER_RATE_LIMIT", "1000");
    for (let i = 0; i < IP_LIMIT; i++) expect((await POST(req(UPLOAD))).status).toBe(200);
    expect((await POST(req(UPLOAD))).status).toBe(429);
    expect((await POST(req(UPLOAD, "198.51.100.99"))).status).toBe(200);
  });

  it("admits no more than the limit when uploads race", async () => {
    const results = await Promise.all(
      Array.from({ length: UPLOAD_LIMIT * 4 }, async () => (await POST(req(UPLOAD))).status)
    );
    // Concurrency safety comes from the shared atomic upsert, not a lock here.
    expect(results.filter((s) => s === 200).length).toBe(UPLOAD_LIMIT);
  });
});

describe("POST /api/files — limiter store failure", () => {
  beforeEach(() => {
    storeError = new Error("connection terminated unexpectedly");
  });

  it("fails closed with 503, never 429", async () => {
    const res = await POST(req(UPLOAD));
    expect(res.status).toBe(503);
  });

  it("uploads nothing and runs no embedding when the store is down", async () => {
    await POST(req(UPLOAD));
    expect(inserted).not.toHaveBeenCalled();
    expect(generateEmbedding).not.toHaveBeenCalled();
  });

  it("never leaks the database error to the caller", async () => {
    storeError = new Error("FATAL: password authentication failed for user nexa_admin");
    const body = await (await POST(req(UPLOAD))).text();
    expect(body).not.toMatch(/password|nexa_admin|FATAL|postgres|rate_limit_buckets/i);
  });
});

describe("file_search LIKE-pattern safety", () => {
  it("escapes the percent wildcard so it cannot match everything", () => {
    // Before this, `%` was interpolated raw and turned the search into
    // "return every document this user owns".
    expect(sanitizeLikePattern("%")).toBe("\\%");
    expect(sanitizeLikePattern("100%")).toBe("100\\%");
  });

  it("escapes the single-character wildcard", () => {
    expect(sanitizeLikePattern("_")).toBe("\\_");
    expect(sanitizeLikePattern("a_b")).toBe("a\\_b");
  });

  it("escapes the escape character itself, first", () => {
    // A trailing backslash would otherwise escape the closing `%` and make
    // the whole pattern invalid.
    expect(sanitizeLikePattern("a\\")).toBe("a\\\\");
    expect(sanitizeLikePattern("\\%")).toBe("\\\\\\%");
  });

  it("leaves an ordinary term untouched", () => {
    expect(sanitizeLikePattern("invoice")).toBe("invoice");
    expect(sanitizeLikePattern("Q3 report 2026")).toBe("Q3 report 2026");
  });

  it("handles an empty term", () => {
    expect(sanitizeLikePattern("")).toBe("");
  });
});

describe("cross-origin state-change defence", () => {
  // The middleware is the single place this runs, before any route handler.
  const call = (url: string, method: string, origin?: string) => {
    const req = new NextRequest(url, {
      method,
      headers: origin ? { origin } : {},
    });
    return middleware(req);
  };

  it("refuses a cross-origin state-changing request", () => {
    const res = call("http://localhost/api/files", "POST", "https://evil.example");
    expect(res.status).toBe(403);
  });

  it("refuses an opaque (null) origin", () => {
    const res = call("http://localhost/api/files", "POST", "null");
    expect(res.status).toBe(403);
  });

  it("refuses an unparseable origin", () => {
    const res = call("http://localhost/api/chat", "POST", "not a url");
    expect(res.status).toBe(403);
  });

  it("allows a same-origin state-changing request", () => {
    const res = call("http://localhost/api/files", "POST", "http://localhost");
    // Not 403: it proceeds to the route layer (here, an unauthenticated 401).
    expect(res.status).not.toBe(403);
  });

  it("allows a request with no Origin header (non-browser client)", () => {
    // curl, scripts and server-to-server calls must keep working, and a
    // browser always sends Origin on a cross-site state-changing request.
    const res = call("http://localhost/api/files", "POST");
    expect(res.status).not.toBe(403);
  });

  it("leaves read-only requests alone", () => {
    // A cross-site GET cannot change state, and SameSite=Lax still sends the
    // cookie there, so refusing it would break nothing useful and could break
    // legitimate embeds.
    const res = call("http://localhost/api/files", "GET", "https://evil.example");
    expect(res.status).not.toBe(403);
  });

  it("does not impose browser CSRF rules on API-key routes", () => {
    // `/v1` is excluded by the matcher: it is bearer-authenticated, not
    // cookie-authenticated, so browser CSRF rules do not apply.
    expect(matcher).toContain("/api/:path*");
    expect(matcher[0]).toMatch(/\(\?!api\|v1\|/);
  });
});
