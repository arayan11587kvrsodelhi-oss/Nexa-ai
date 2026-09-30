/**
 * Phase 5.5 — `POST /api/models/test` SSRF regression.
 *
 * The route builds a provider adapter and calls `testConnection()`, which issues
 * a real outbound `fetch`. Before this phase, only the FreeLLMAPI branch refused
 * a caller-supplied `baseUrl`; every other provider passed it straight through
 * and the adapters fetch whatever URL they are given, with no validation.
 *
 * These tests drive the real route with `fetch` instrumented, so the property
 * under test is *whether a request is ever issued to the attacker's URL* — not
 * merely that a flag was set.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const OWNER = "usr_owner";
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

/** Every URL the process was asked to fetch during a test. */
let fetched: string[] = [];
const realFetch = globalThis.fetch;

/** Records the URL and returns a harmless, well-formed provider response. */
function stubFetch(): void {
  fetched = [];
  globalThis.fetch = (async (input: unknown) => {
    fetched.push(String(typeof input === "string" ? input : (input as { url?: string })?.url ?? input));
    return new Response(
      JSON.stringify({ models: [{ name: "probe" }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof globalThis.fetch;
}

const { POST } = await import("@/app/api/models/test/route");

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/models/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  sessionUser = OWNER;
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("provider test — SSRF via a request-supplied endpoint", () => {
  const targets = [
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:5432/",
    "http://10.0.0.5/internal",
    "http://[::1]:8080/admin",
    "http://localhost:11434/",
  ];

  for (const target of targets) {
    it(`refuses ${target} without contacting it`, async () => {
      const res = await POST(post({ provider: "ollama", baseUrl: target }));
      expect(res.status).toBe(400);
      // The decisive assertion: the attacker's URL was never requested.
      expect(fetched.some((u) => u.includes(target.replace(/\/$/, "")))).toBe(false);
    });
  }

  it("refuses a caller-supplied API key", async () => {
    const res = await POST(post({ provider: "openai_compatible", apiKey: "sk-attacker" }));
    expect(res.status).toBe(400);
    expect(fetched).toHaveLength(0);
  });

  it("refuses the request even for the ollama default provider", async () => {
    const res = await POST(post({ baseUrl: "http://169.254.169.254/" }));
    expect(res.status).toBe(400);
  });

  it("still rejects an unsupported provider name", async () => {
    const res = await POST(post({ provider: "not-a-provider" }));
    expect(res.status).toBe(400);
    expect(fetched).toHaveLength(0);
  });

  it("requires authentication before any connection is attempted", async () => {
    sessionUser = null;
    const res = await POST(post({ provider: "ollama", baseUrl: "http://169.254.169.254/" }));
    expect(res.status).toBe(401);
    expect(fetched).toHaveLength(0);
  });
});

describe("provider test — legitimate use still works", () => {
  it("tests a provider from server-side configuration alone", async () => {
    // The UI sends only `provider`; the adapter resolves its own endpoint.
    const res = await POST(post({ provider: "ollama" }));
    expect(res.status).toBe(200);
    expect(fetched.length).toBeGreaterThan(0);
  });

  it("treats a request with no body as a default provider test", async () => {
    const empty = new NextRequest("http://localhost/api/models/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect((await POST(empty)).status).toBe(200);
  });

  it("does not echo the server-side API key back to the caller", async () => {
    const res = await POST(post({ provider: "ollama" }));
    const text = await res.text();
    // Whatever the provider reports, a credential must never appear.
    expect(text).not.toMatch(/api[_-]?key|authorization|bearer/i);
  });
});
