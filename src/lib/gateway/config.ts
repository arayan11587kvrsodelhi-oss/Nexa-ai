/**
 * NEXA AI Gateway — configuration and URL safety.
 *
 * All provider configuration is read from the *server* environment (plus the
 * existing per-user `model_configs` row for bring-your-own-endpoint providers).
 * Nothing here is ever shipped to the browser, and nothing here writes a
 * credential into a URL.
 *
 * Provider endpoints are validated as URLs, not trusted as strings: a
 * configurable provider base URL must not become an unrestricted SSRF
 * primitive (see `validateProviderUrl`).
 */
import { GATEWAY_PROVIDER_IDS, type GatewayProviderId } from "./types";

export interface GatewayProviderConfig {
  id: GatewayProviderId;
  name: string;
  /** False when the provider has no usable configuration at all. */
  enabled: boolean;
  /** Endpoint that would be called. Never contains a credential. */
  baseUrl: string;
  /** Server-side credential. Never logged, never serialized, never in a URL. */
  apiKey?: string;
  requiresApiKey: boolean;
  /** Model NEXA should prefer for this provider when routing `auto`. */
  preferredModel?: string;
  /** Lower runs first. Deterministic; taken from NEXA_PROVIDER_ORDER. */
  priority: number;
  /** Operator-facing explanation, shown verbatim in the UI. */
  note: string;
}

/** Deterministic default order. Overridable with NEXA_PROVIDER_ORDER. */
export const DEFAULT_PROVIDER_ORDER: readonly GatewayProviderId[] = [
  "freellmapi",
  "aihorde",
  "ollama",
  "openai_compatible",
  "vllm",
];

export const AI_HORDE_DEFAULT_BASE_URL = "https://oai.aihorde.net/v1";
/** AI Horde's documented anonymous key. Sent only when no real key is set. */
export const AI_HORDE_ANONYMOUS_KEY = "0000000000";
export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
export const OPENAI_COMPATIBLE_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function envFlag(name: string): boolean {
  return env(name).toLowerCase() === "true";
}

export function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const value = Math.trunc(parsed);
  return Math.min(max, Math.max(min, value));
}

/** True when configured provider URLs may target loopback/private networks. */
export function allowPrivateProviderHosts(): boolean {
  if (envFlag("NEXA_ALLOW_PRIVATE_PROVIDER_HOSTS")) return true;
  // Local development reaches Ollama/FreeLLMAPI on 127.0.0.1 by design.
  return process.env.NODE_ENV !== "production";
}

function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const parts = match.slice(1).map((p) => Number(p));
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!value.includes(":")) return false;
  if (value === "::1" || value === "::") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true; // unique local
  if (/^fe[89ab]/.test(value)) return true; // link-local
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

const BLOCKED_METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "metadata",
  "100.100.100.200", // Alibaba Cloud metadata
  "fd00:ec2::254", // AWS IMDSv2 IPv6
]);

/**
 * Link-local addresses are never a legitimate provider endpoint, and they are
 * where cloud instance metadata lives (169.254.169.254 on AWS/Azure/GCP and most
 * other clouds).
 *
 * This is checked *before* the "private hosts are allowed" escape hatch, and
 * deliberately ignores that flag. The flag exists so a developer can point NEXA
 * at Ollama on 127.0.0.1; it must not also open an SSRF path to the credential
 * store of the machine NEXA is running on.
 */
function isLinkLocalMetadataAddress(host: string): boolean {
  if (host === "169.254.169.254" || host === "metadata.google.internal") return true;
  // 169.254.0.0/16, the whole link-local block.
  const match = /^169\.254\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  return match.slice(1).every((part) => {
    const n = Number(part);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

export interface UrlValidationResult {
  ok: boolean;
  /** Operator-facing reason when `ok` is false. Never contains a credential. */
  reason?: string;
}

/**
 * Validate a provider base URL.
 *
 * Rejects: non-http(s) schemes (file:, ftp:, gopher:, data:), embedded
 * credentials, cloud metadata endpoints and — unless explicitly allowed —
 * loopback / private / link-local addresses.
 *
 * Known limitation (documented, not hidden): DNS is not resolved here, so a
 * hostname that *resolves* to a private address is only caught when the
 * operator opts into private hosts. Private-host access therefore has to be an
 * explicit decision, and this module never follows redirects.
 */
export function validateProviderUrl(
  rawUrl: string,
  options: { allowPrivate?: boolean; label?: string } = {}
): UrlValidationResult {
  const label = options.label ?? "provider URL";
  const value = (rawUrl ?? "").trim();
  if (!value) return { ok: false, reason: `The ${label} is empty.` };

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: `The ${label} is not a valid absolute URL.` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `The ${label} must use http or https (received "${parsed.protocol.replace(":", "")}").`,
    };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      reason: `The ${label} must not embed credentials; configure an API key variable instead.`,
    };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // Unconditional: the "allow private hosts" flag is for reaching a local Ollama,
  // never for reaching the credential service of the host NEXA runs on.
  if (BLOCKED_METADATA_HOSTS.has(host) || isLinkLocalMetadataAddress(host)) {
    return { ok: false, reason: `The ${label} must not target a cloud metadata endpoint.` };
  }

  const allowPrivate = options.allowPrivate ?? allowPrivateProviderHosts();
  const isPrivate =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    isPrivateIpv4(host) ||
    isPrivateIpv6(host);

  if (isPrivate && !allowPrivate) {
    return {
      ok: false,
      reason: `The ${label} targets a private, loopback or link-local host (${host}). Set NEXA_ALLOW_PRIVATE_PROVIDER_HOSTS=true only if the provider really is on a private network.`,
    };
  }

  return { ok: true };
}

/** Strip a trailing `/v1` so `/v1/...` paths are never duplicated. */
export function normalizeBaseUrl(raw: string | undefined): string {
  let url = (raw ?? "").trim();
  if (!url) return "";
  url = url.replace(/\/+$/, "");
  return /\/v1$/i.test(url) ? url.slice(0, -3).replace(/\/+$/, "") : url;
}

/**
 * Canonical base URL for providers that expose an **OpenAI-shaped** API.
 *
 * These adapters append their own paths (`/models`, `/chat/completions`) to the
 * base, so the base must RETAIN the API version prefix:
 *
 *   https://oai.aihorde.net/v1  + /models  -> /v1/models
 *   http://localhost:1234/v1    + /models  -> /v1/models
 *
 * Stripping `/v1` here (as `normalizeBaseUrl` does for the `/api/*` family) is
 * a real 404 in production, not a cosmetic difference — an operator's
 * documented URL must work exactly as written.
 *
 * The suffix is added when missing so a bare host (`http://localhost:1234`)
 * also resolves to the documented OpenAI-compatible path. Idempotent.
 */
export function normalizeOpenAIBaseUrl(raw: string | undefined): string {
  const url = (raw ?? "").trim().replace(/\/+$/, "");
  if (!url) return "";
  return /\/v1$/i.test(url) ? url : `${url}/v1`;
}

/** Parse NEXA_PROVIDER_ORDER, dropping anything that is not a known provider. */
export function resolveProviderOrder(): GatewayProviderId[] {
  const raw = env("NEXA_PROVIDER_ORDER");
  const requested = raw
    ? raw
        .split(",")
        .map((part) => part.trim().toLowerCase())
        .filter((part): part is GatewayProviderId =>
          (GATEWAY_PROVIDER_IDS as readonly string[]).includes(part)
        )
    : [];
  const ordered = requested.length > 0 ? requested : [...DEFAULT_PROVIDER_ORDER];
  // Any provider the operator did not mention keeps a deterministic position.
  for (const id of DEFAULT_PROVIDER_ORDER) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered;
}

/**
 * Every provider's configuration, in deterministic priority order.
 *
 * A provider is `enabled` only when it has enough configuration to be called:
 *
 *  - `freellmapi`: FREELLMAPI_BASE_URL set (key optional for a local install).
 *                  This is NEXA's active engine and the only provider enabled
 *                  by default.
 *  - `aihorde`:    explicit opt-in (`AI_HORDE_ENABLED=true` or a key/model),
 *                  because it is a third-party service
 *  - `ollama`:     never enabled — it is not the active engine
 *  - `openai_compatible`: base URL set (env, or a per-user config row)
 */
export function loadGatewayConfig(
  overrides: Partial<Record<GatewayProviderId, { baseUrl?: string; apiKey?: string }>> = {}
): GatewayProviderConfig[] {
  const order = resolveProviderOrder();
  const priorityOf = (id: GatewayProviderId) => {
    const index = order.indexOf(id);
    return index === -1 ? order.length : index;
  };

  const configs: GatewayProviderConfig[] = [];

  /* AI Horde -------------------------------------------------------------- */
  const hordeKey = env("AI_HORDE_API_KEY") || overrides.aihorde?.apiKey || "";
  const hordeOptIn = envFlag("AI_HORDE_ENABLED") || Boolean(env("AI_HORDE_API_KEY"));
  const hordeBase = normalizeOpenAIBaseUrl(env("AI_HORDE_BASE_URL") || AI_HORDE_DEFAULT_BASE_URL);
  const hordeUrl = validateProviderUrl(hordeBase, { label: "AI Horde base URL" });
  configs.push({
    id: "aihorde",
    name: "AI Horde",
    enabled: hordeOptIn && hordeUrl.ok,
    baseUrl: hordeBase,
    apiKey: hordeKey || AI_HORDE_ANONYMOUS_KEY,
    // Usable with AI Horde's anonymous key; a real key only raises queue priority.
    requiresApiKey: false,
    preferredModel: env("AI_HORDE_MODEL") || undefined,
    priority: priorityOf("aihorde"),
    note: !hordeOptIn
      ? "Disabled. Set AI_HORDE_ENABLED=true (optionally with AI_HORDE_API_KEY) to route to AI Horde."
      : hordeUrl.ok
        ? hordeKey
          ? "Enabled with a registered AI Horde key."
          : "Enabled with AI Horde's anonymous key (lower queue priority)."
        : `Disabled: ${hordeUrl.reason}`,
  });

  /* Ollama ---------------------------------------------------------------- */
  // NEXA runs on FreeLLMAPI. The Ollama gateway adapter is retained so an
  // operator can still address it explicitly, but it is never enabled for
  // routing: Ollama is not the active engine and is not required to run NEXA.
  const ollamaBase = normalizeBaseUrl(
    overrides.ollama?.baseUrl || env("OLLAMA_BASE_URL") || OLLAMA_DEFAULT_BASE_URL
  );
  const ollamaUrl = validateProviderUrl(ollamaBase, { label: "Ollama base URL" });
  configs.push({
    id: "ollama",
    name: "Ollama",
    enabled: false,
    baseUrl: ollamaBase,
    requiresApiKey: false,
    preferredModel: env("OLLAMA_MODEL") || undefined,
    priority: priorityOf("ollama"),
    note: ollamaUrl.ok
      ? "Disabled: NEXA is served by FreeLLMAPI. Ollama is not the active engine and is not used for routing."
      : `Disabled: ${ollamaUrl.reason}`,
  });

  /* Generic OpenAI-compatible endpoint ------------------------------------ */
  const openaiBase = normalizeOpenAIBaseUrl(
    overrides.openai_compatible?.baseUrl ||
      env("OPENAI_COMPATIBLE_BASE_URL") ||
      env("OPENAI_COMPATIBLE_URL") ||
      env("OPENAI_BASE_URL") ||
      (envFlag("NEXA_ENABLE_LOCAL_OPENAI_COMPATIBLE") ? OPENAI_COMPATIBLE_DEFAULT_BASE_URL : "")
  );
  const openaiUrl = validateProviderUrl(openaiBase, { label: "OpenAI-compatible base URL" });
  const openaiEnabled = Boolean(openaiBase) && openaiUrl.ok;
  for (const id of ["openai_compatible", "vllm"] as const) {
    configs.push({
      id,
      name: id === "vllm" ? "vLLM" : "OpenAI-compatible endpoint",
      // vLLM is reached through the same adapter; it is only enabled when the
      // operator names it in NEXA_PROVIDER_ORDER explicitly.
      enabled: openaiEnabled && id === "openai_compatible",
      baseUrl: openaiBase,
      apiKey: overrides.openai_compatible?.apiKey || env("OPENAI_COMPATIBLE_API_KEY") || undefined,
      requiresApiKey: false,
      preferredModel: env("OPENAI_COMPATIBLE_MODEL") || undefined,
      priority: priorityOf(id),
      note: openaiEnabled
        ? "Configured OpenAI-compatible endpoint (LM Studio, vLLM, ...)."
        : openaiBase
          ? `Disabled: ${openaiUrl.reason}`
          : "Disabled. Set OPENAI_COMPATIBLE_BASE_URL to enable it.",
    });
  }

  /* External FreeLLMAPI (kept while the native gateway is proven) ---------- */
  const freeBase = normalizeBaseUrl(overrides.freellmapi?.baseUrl || env("FREELLMAPI_BASE_URL"));
  const freeUrl = validateProviderUrl(freeBase, { label: "FreeLLMAPI base URL" });
  configs.push({
    id: "freellmapi",
    name: "FreeLLMAPI (external)",
    enabled: Boolean(freeBase) && freeUrl.ok,
    baseUrl: freeBase,
    apiKey: overrides.freellmapi?.apiKey || env("FREELLMAPI_API_KEY") || undefined,
    requiresApiKey: false,
    preferredModel: env("FREELLMAPI_MODEL") || undefined,
    priority: priorityOf("freellmapi"),
    note: !freeBase
      ? "Disabled. Set FREELLMAPI_BASE_URL to keep using the external gateway while NEXA's own routing is proven."
      : freeUrl.ok
        ? "External OpenAI-compatible gateway. Models are discovered at request time."
        : `Disabled: ${freeUrl.reason}`,
  });

  return configs.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

export function findProviderConfig(
  id: GatewayProviderId,
  overrides: Partial<Record<GatewayProviderId, { baseUrl?: string; apiKey?: string }>> = {}
): GatewayProviderConfig {
  const config = loadGatewayConfig(overrides).find((c) => c.id === id);
  if (!config) throw new Error(`Unknown gateway provider '${id}'.`);
  return config;
}

/** Safe, credential-free projection of a provider config for API responses. */
export function publicProviderConfig(config: GatewayProviderConfig): Record<string, unknown> {
  return {
    id: config.id,
    name: config.name,
    enabled: config.enabled,
    baseUrl: config.baseUrl || null,
    requiresApiKey: config.requiresApiKey,
    hasCredential: Boolean(config.apiKey),
    preferredModel: config.preferredModel ?? null,
    priority: config.priority,
    note: config.note,
  };
}
