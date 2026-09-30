/**
 * NEXA AI Gateway — deployment-target compatibility (Phase 12).
 *
 * Vercel can host the NEXA UI, the API and the gateway. It cannot host the LLM.
 * These tests pin the behaviours that make that safe, so a future change cannot
 * quietly turn a serverless deployment into a deployment that believes it has a
 * local model.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  allowPrivateProviderHosts,
  loadGatewayConfig,
  validateProviderUrl,
  publicProviderConfig,
} from "@/lib/gateway/config";
import { GatewayHealthStore } from "@/lib/gateway/health";
import { GatewayModelRegistry } from "@/lib/gateway/registry";

const ENV_KEYS = [
  "NODE_ENV",
  "NEXA_ALLOW_PRIVATE_PROVIDER_HOSTS",
  "FREELLMAPI_BASE_URL",
  "OLLAMA_BASE_URL",
  "OPENAI_COMPATIBLE_BASE_URL",
  "AI_HORDE_ENABLED",
  "AI_HORDE_BASE_URL",
  "NEXA_PROVIDER_ORDER",
];
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  vi.unstubAllEnvs();
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  GatewayHealthStore.reset();
  GatewayModelRegistry.reset();
});

describe("A loopback provider is not usable in production", () => {
  it("rejects 127.0.0.1 and localhost when NODE_ENV is production", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.NEXA_ALLOW_PRIVATE_PROVIDER_HOSTS;
    expect(allowPrivateProviderHosts()).toBe(false);
    for (const url of ["http://127.0.0.1:31417/v1", "http://localhost:11434", "http://[::1]:1234/v1"]) {
      expect(validateProviderUrl(url, { label: "provider" }).ok, url).toBe(false);
    }
  });

  it("blocks the cloud metadata address even when private hosts are allowed", () => {
    // Loopback is a legitimate local-dev need; 169.254.169.254 never is. The
    // allow-private flag must not become an SSRF path to instance credentials.
    process.env.NEXA_ALLOW_PRIVATE_PROVIDER_HOSTS = "true";
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://169.254.1.1/",
      "http://100.100.100.200/",
      "http://metadata.google.internal/",
    ]) {
      expect(validateProviderUrl(url, { label: "provider" }).ok, url).toBe(false);
    }
    // A genuine loopback provider is still reachable with the flag on.
    expect(validateProviderUrl("http://127.0.0.1:11434", { label: "Ollama" }).ok).toBe(true);
  });

  it("reports a production deployment as having no usable local provider", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.NEXA_ALLOW_PRIVATE_PROVIDER_HOSTS;
    delete process.env.AI_HORDE_ENABLED;
    delete process.env.AI_HORDE_BASE_URL;
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";
    process.env.FREELLMAPI_BASE_URL = "http://127.0.0.1:31417/v1";

    const configs = loadGatewayConfig();
    const ollama = configs.find((c) => c.id === "ollama");
    const freellmapi = configs.find((c) => c.id === "freellmapi");
    // Disabled with an operator-facing reason, rather than silently "configured"
    // and failing at request time on every call.
    expect(ollama?.enabled).toBe(false);
    expect(ollama?.note).toMatch(/Disabled:/);
    expect(freellmapi?.enabled).toBe(false);
  });

  it("accepts a public https provider in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.NEXA_ALLOW_PRIVATE_PROVIDER_HOSTS;
    expect(validateProviderUrl("https://oai.aihorde.net/v1", { label: "AI Horde" }).ok).toBe(true);
  });
});

describe("Gateway state that must survive a cold serverless instance", () => {
  it("treats the in-memory catalogue as a cache, not as truth", () => {
    GatewayModelRegistry.reset();
    // A cold instance has nothing; that must be "unknown", never "healthy".
    expect(GatewayModelRegistry.allModels()).toEqual([]);
    expect(GatewayHealthStore.get("aihorde", "m")).toBeUndefined();
    // A provider with no observation reports a state, not a health claim.
    expect(GatewayHealthStore.providerStatus("aihorde")).toBe("configured");
  });

  it("keeps provider ids and URLs in a serializable, credential-free form", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.AI_HORDE_ENABLED = "true";
    process.env.AI_HORDE_API_KEY = "a-real-looking-secret-value";
    const config = loadGatewayConfig().find((c) => c.id === "aihorde");
    const view = publicProviderConfig(config!);
    // This is exactly what reaches the browser: a plain object, no secret.
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    expect(JSON.stringify(view)).not.toContain("a-real-looking-secret-value");
    expect(view.hasCredential).toBe(true);
  });
});
