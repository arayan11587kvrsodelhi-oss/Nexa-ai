/**
 * Phase 8.4 — project-scoped document filtering.
 *
 * `GET /api/files` gained an optional `projectId` narrowing parameter. The
 * property that must hold is narrower and more important than the feature
 * itself: adding a client-supplied filter must never become a way to *reach*
 * data. The `userId` condition stays authoritative, so a foreign project id
 * yields an empty list rather than another tenant's documents — and the
 * response cannot distinguish "no such project" from "not your project",
 * because both are the same empty list.
 *
 * The test evaluates the query conditions the code actually builds, so a
 * missing owner condition would return the foreign row exactly as Postgres
 * would.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const ALICE = "usr_alice";
const BOB = "usr_bob";
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

let docs: Array<{
  id: string;
  name: string;
  userId: string;
  projectId: string | null;
  createdAt: Date;
}> = [];
let conditions: Array<{ col: string; op: string; val: unknown }> = [];

vi.mock("drizzle-orm", () => ({
  and: (...c: unknown[]) => ({ conds: c }),
  eq: (col: unknown, val: unknown) => ({ col, op: "eq", val }),
  desc: (col: unknown) => ({ col }),
}));

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (c: { conds?: unknown[] }) => ({
          orderBy: () => ({
            limit: async () => {
              const conds = (c?.conds ?? []) as Array<{ col: string; op: string; val: unknown }>;
              conditions = conds;
              return docs
                .filter((d) =>
                  conds.every((x) =>
                    x.op === "eq"
                      ? (d as unknown as Record<string, unknown>)[x.col] === x.val
                      : true
                  )
                )
                .map((d) => ({
                  id: d.id,
                  name: d.name,
                  mimeType: "text/plain",
                  size: 10,
                  characterCount: 10,
                  chunkCount: 1,
                  status: "indexed",
                  projectId: d.projectId,
                  createdAt: d.createdAt,
                }));
            },
          }),
        }),
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  documents: {
    id: "id",
    name: "name",
    mimeType: "mimeType",
    size: "size",
    characterCount: "characterCount",
    chunkCount: "chunkCount",
    status: "status",
    projectId: "projectId",
    createdAt: "createdAt",
    userId: "userId",
  },
  documentChunks: {},
  projects: {},
}));

const { GET } = await import("@/app/api/files/route");

const get = (qs = "") =>
  GET(new NextRequest(`http://localhost/api/files${qs}`)) as Promise<Response>;


describe("GET /api/files — project narrowing", () => {
  it("returns only the caller's documents in that project", async () => {
    const body = await (await get("?projectId=prj_alice")).json();
    const ids = body.documents.map((d: { id: string }) => d.id);
    expect(ids).toEqual(["d_alice_proj"]);
  });

  it("keeps the owner condition when a project is selected", async () => {
    await get("?projectId=prj_alice");
    expect(conditions.some((c) => c.op === "eq" && c.val === ALICE)).toBe(true);
    expect(conditions.some((c) => c.op === "eq" && c.val === "prj_alice")).toBe(true);
  });

  it("returns an empty list for another tenant's project id", async () => {
    const body = await (await get("?projectId=prj_bob")).json();
    // The critical property: a forged project id reveals nothing.
    expect(body.documents).toEqual([]);
  });

  it("does not reveal that a foreign project exists", async () => {
    const foreign = await (await get("?projectId=prj_bob")).json();
    const nonexistent = await (await get("?projectId=prj_does_not_exist")).json();
    // Identical responses: existence of another tenant's project is not probeable.
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(nonexistent));
  });

  it("does not leak a foreign document name", async () => {
    const body = await (await get("?projectId=prj_bob")).json();
    expect(JSON.stringify(body)).not.toContain("Bob");
  });

  it("treats an empty or blank projectId as no filter", async () => {
    const body = await (await get("?projectId=")).json();
    expect(body.documents.length).toBe(2);
    const blank = await (await get("?projectId=%20%20")).json();
    expect(blank.documents.length).toBe(2);
  });

  it("is symmetric: Bob still cannot see Alice's project", async () => {
    sessionUser = BOB;
    const body = await (await get("?projectId=prj_alice")).json();
    expect(body.documents).toEqual([]);
  });
});

describe("GET /api/files — authentication", () => {
  it("rejects an anonymous caller and issues no query", async () => {
    sessionUser = null;
    const res = await get();
    expect(res.status).toBe(401);
    expect(conditions).toHaveLength(0);
  });
});


beforeEach(() => {
  sessionUser = ALICE;
  conditions = [];
  docs = [
    { id: "d_alice_general", name: "Alice general", userId: ALICE, projectId: null, createdAt: new Date(2) },
    { id: "d_alice_proj", name: "Alice in project", userId: ALICE, projectId: "prj_alice", createdAt: new Date(1) },
    { id: "d_bob_proj", name: "Bob in project", userId: BOB, projectId: "prj_bob", createdAt: new Date(3) },
  ];
});
describe("GET /api/files — no filter returns only the caller's documents", () => {
  it("excludes another tenant's documents", async () => {
    const body = await (await get()).json();
    const ids = body.documents.map((d: { id: string }) => d.id);
    expect(ids).toContain("d_alice_general");
    expect(ids).toContain("d_alice_proj");
    expect(ids).not.toContain("d_bob_proj");
  });

  it("always applies the owner condition", async () => {
    await get();
    expect(conditions.some((c) => c.op === "eq" && c.val === ALICE)).toBe(true);
  });
});
