/**
 * Phase 5.7 — unauthenticated internal-topology disclosure via `/api/health`.
 *
 * `/api/health` is deliberately unauthenticated so a load balancer can call
 * it. It used to return `engine.baseUrl` — the operator's provider endpoint,
 * i.e. an internal host, IP and port — to any anonymous caller.
 *
 * The property under test is behavioural: an anonymous GET must not disclose
 * any configured endpoint, while the signals a monitor actually needs must
 * survive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** Endpoints an operator might plausibly run NEXA against, all "internal". */
const INTERNAL_ENDPOINTS = [
  "http://10.0.0.5:31415/v1",
  "http://192.168.7.9:11434",
  "http://freellmapi.internal.svc.cluster.local:8080/v1",
  "http://127.0.0.1:31415/v1",
];

vi.mock("@/db", () => ({
  checkDatabase: async () => ({
    configured: true,
    reachable: true,
    // A deliberately recognisable host/port, to prove even a *host* is not
    // echoed anywhere in the public payload.
    message: "Connected.",
  }),
}));

const { GET, HEAD } = await import("@/app/api/health/route");

beforeEach(() => {
  vi.stubEnv("DEFAULT_PROVIDER", "freellmapi");
  vi.stubEnv("FREELLMAPI_BASE_URL", INTERNAL_ENDPOINTS[0]);
  vi.stubEnv("OLLAMA_BASE_URL", INTERNAL_ENDPOINTS[1]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/health — no internal endpoint disclosure", () => {
  it("does not return the provider baseUrl", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.engine.baseUrl).toBeUndefined();
    expect(body.engine).not.toHaveProperty("baseUrl");
  });

  it("publishes no configured endpoint anywhere in the payload", async () => {
    const res = await GET();
    const text = JSON.stringify(await res.json());
    for (const endpoint of INTERNAL_ENDPOINTS) {
      expect(text, endpoint).not.toContain(endpoint);
    }
  });

  it("leaks no host, IP or port fragment", async () => {
    const res = await GET();
    const text = JSON.stringify(await res.json());
    // Guards against the endpoint being reformatted rather than removed.
    for (const fragment of ["10.0.0.5", "192.168.7.9", "31415", "11434", "svc.cluster.local"]) {
      expect(text, fragment).not.toContain(fragment);
    }
  });

  it("does not leak an internal host supplied as a bare hostname", async () => {
    vi.stubEnv("FREELLMAPI_BASE_URL", INTERNAL_ENDPOINTS[2]);
    const res = await GET();
    expect(JSON.stringify(await res.json())).not.toContain("svc.cluster.local");
  });

  it("keeps the provider name so diagnostics still work", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.engine.provider).toBe("freellmapi");
  });
});

describe("GET /api/health — monitor-facing contract preserved", () => {
  it("stays a 200 liveness probe with its existing shape", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    // A monitor or the diagnostics panel depends on all of these.
    expect(body.ok).toBe(true);
    expect(body.app).toBe("nexa-ai");
    expect(typeof body.version).toBe("string");
    expect(body.database).toMatchObject({ configured: true, reachable: true });
  });

  it("keeps HEAD as the readiness probe", async () => {
    const res = await HEAD();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-nexa-db")).toBe("up");
  });
});
