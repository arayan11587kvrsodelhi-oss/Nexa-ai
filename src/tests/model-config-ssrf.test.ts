/**
 * Phase 5.6 — stored SSRF via `POST /api/models`.
 *
 * A user-supplied `baseUrl` is persisted into `model_configs.base_url` and then
 * read back and fetched by `GET /api/models` and `/api/chat`. Before this phase
 * it was stored verbatim, so one config write made every later request a
 * server-side request to an address the caller chose.
 *
 * The property under test is behavioural: the value is never *stored*, and no
 * fetch is ever issued to it. `fetch` is instrumented so a regression shows up
 * as a real outbound request, not merely a missing flag.
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

/** Every row written to the model-config table, so "stored?" is observable. */
let stored: Array<Record<string, unknown>> = [];
vi.mock("@/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        stored.push(row);
        return {
          returning: async () => [{ id: "cfg_1", createdAt: new Date(0), ...row }],
        };
      },
    }),
  },
}));
vi.mock("@/db/schema", () => ({ modelConfigs: { name: "model_configs" } }));
// Stub the read-back probe so the route imports cleanly without network I/O.
vi.mock("@/lib/gateway/gateway", () => ({ NexaGateway: { health: async () => null } }));

const { validateProviderUrl } = await import("@/lib/gateway/config");

let fetched: string[] = [];
const realFetch = globalThis.fetch;

const { POST } = await import("@/app/api/models/route");

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Internal / metadata targets that must never be accepted or contacted. */
const INTERNAL_TARGETS = [
  "http://169.254.169.254/latest/meta-data/",
  "http://127.0.0.1:5432/",
  "http://10.0.0.5/internal",
  "http://192.168.1.1/admin",
  "http://[::1]:8080/admin",
  "http://169.254.1.1/",
  "http://metadata.google.internal/",
];

beforeEach(() => {
  stored = [];
  fetched = [];
  sessionUser = OWNER;
  // Production posture: private/loopback targets are refused unless the
  // operator opts in. This is what makes the assertions below meaningful.
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXA_ALLOW_PRIVATE_PROVIDER_HOSTS", "");
  globalThis.fetch = (async (input: unknown) => {
    const url =
      typeof input === "string" ? input : ((input as { url?: string })?.url ?? String(input));
    fetched.push(url);
    return new Response(JSON.stringify({ models: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

describe("model config — stored SSRF", () => {
  for (const target of INTERNAL_TARGETS) {
    it(`refuses to store ${target}`, async () => {
      const res = await POST(post({ provider: "ollama", baseUrl: target }));
      expect(res.status).toBe(400);
      // The decisive assertion: nothing reached the database, so the value can
      // never be read back and fetched later.
      expect(stored).toHaveLength(0);
      expect(fetched).toHaveLength(0);
    });
  }

  it("rejects a non-http scheme", async () => {
    const res = await POST(post({ provider: "ollama", baseUrl: "file:///etc/passwd" }));
    expect(res.status).toBe(400);
    expect(stored).toHaveLength(0);
  });

  it("rejects a URL with embedded credentials", async () => {
    const res = await POST(
      post({ provider: "openai_compatible", baseUrl: "https://user:pass@example.com" })
    );
    expect(res.status).toBe(400);
    expect(stored).toHaveLength(0);
  });

  it("requires authentication before anything is stored", async () => {
    sessionUser = null;
    const res = await POST(post({ provider: "ollama", baseUrl: "http://169.254.169.254/" }));
    expect(res.status).toBe(401);
    expect(stored).toHaveLength(0);
  });

  it("keeps the FreeLLMAPI server-side-configuration rule", async () => {
    const res = await POST(post({ provider: "freellmapi", baseUrl: "https://api.example.com" }));
    expect(res.status).toBe(400);
    expect(stored).toHaveLength(0);
  });
});

describe("model config — legitimate endpoints still work", () => {
  it("accepts a public https OpenAI-compatible endpoint", async () => {
    const res = await POST(
      post({ provider: "openai_compatible", baseUrl: "https://api.example.com/v1" })
    );
    expect(res.status).toBe(200);
    // The value is persisted, so bring-your-own-endpoint is preserved.
    expect(stored).toHaveLength(1);
    expect(stored[0].baseUrl).toBe("https://api.example.com/v1");
  });

  it("accepts a public http endpoint on a routable address", async () => {
    const res = await POST(post({ provider: "ollama", baseUrl: "http://203.0.113.10:11434" }));
    expect(res.status).toBe(200);
    expect(stored).toHaveLength(1);
  });

  it("omitting baseUrl keeps the previous default behaviour", async () => {
    const res = await POST(post({ provider: "ollama" }));
    expect(res.status).toBe(200);
    expect(stored).toHaveLength(1);
    expect(stored[0].baseUrl).toBe("http://localhost:11434");
  });

  it("allows a private host when the operator has explicitly opted in", async () => {
    // The documented escape hatch for a genuinely private-network provider.
    vi.stubEnv("NEXA_ALLOW_PRIVATE_PROVIDER_HOSTS", "true");
    const res = await POST(post({ provider: "ollama", baseUrl: "http://10.0.0.5:11434" }));
    expect(res.status).toBe(200);
    expect(stored).toHaveLength(1);
  });

  it("still refuses cloud metadata even when private hosts are allowed", async () => {
    // The metadata block is unconditional by design, so the opt-in cannot
    // re-open it.
    vi.stubEnv("NEXA_ALLOW_PRIVATE_PROVIDER_HOSTS", "true");
    const res = await POST(post({ provider: "ollama", baseUrl: "http://169.254.169.254/" }));
    expect(res.status).toBe(400);
    expect(stored).toHaveLength(0);
  });
});

describe("the validator this fix relies on", () => {
  it("rejects metadata, loopback, private and link-local targets in production", () => {
    for (const target of INTERNAL_TARGETS) {
      expect(validateProviderUrl(target, { label: "provider endpoint" }).ok, target).toBe(false);
    }
  });

  it("accepts an ordinary public endpoint", () => {
    expect(validateProviderUrl("https://api.example.com/v1").ok).toBe(true);
  });
});
