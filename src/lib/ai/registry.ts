import { ModelDescriptor, ModelProfile, ProviderType } from "@/types";

export const DEFAULT_MODELS: ModelDescriptor[] = [
  {
    id: "llama3.2:3b",
    name: "Llama 3.2 (3B)",
    provider: "ollama",
    profile: "BALANCED",
    contextWindow: 131072,
    description: "Meta's lightweight model optimized for edge devices, reasoning, and standard chat.",
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    recommendedFor: "Daily conversation, summarizing, and standard QA",
    isLocal: true,
  },
  {
    id: "llama3.2:1b",
    name: "Llama 3.2 (1B)",
    provider: "ollama",
    profile: "FAST",
    contextWindow: 131072,
    description: "Ultra-compact model for fast local responses with minimal hardware requirements.",
    supportsStreaming: true,
    supportsTools: false,
    supportsVision: false,
    recommendedFor: "Quick questions, formatting, and high-speed replies",
    isLocal: true,
  },
  {
    id: "deepseek-r1:8b",
    name: "DeepSeek R1 (8B Distill)",
    provider: "ollama",
    profile: "REASONING",
    contextWindow: 65536,
    description: "Specialized open reasoning model trained with chain-of-thought and math/logic reflection.",
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    recommendedFor: "Complex mathematical deductions, algorithmic logic, and hard puzzles",
    isLocal: true,
  },
  {
    id: "qwen2.5-coder:7b",
    name: "Qwen 2.5 Coder (7B)",
    provider: "ollama",
    profile: "CODING",
    contextWindow: 131072,
    description: "Alibaba's state-of-the-art open code model proficient in 90+ programming languages.",
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    recommendedFor: "Software engineering, debugging, code generation, and test creation",
    isLocal: true,
  },
  {
    id: "llama3.2-vision:11b",
    name: "Llama 3.2 Vision (11B)",
    provider: "ollama",
    profile: "VISION",
    contextWindow: 131072,
    description: "Multimodal model capable of visual understanding, chart reading, and image Q&A.",
    supportsStreaming: true,
    supportsTools: false,
    supportsVision: true,
    recommendedFor: "Diagram analysis, screenshots, visual QA, and OCR",
    isLocal: true,
  },
  {
    id: "mistral:7b",
    name: "Mistral (7B)",
    provider: "ollama",
    profile: "BALANCED",
    contextWindow: 32768,
    description: "High-performance general-purpose model with strong instruction following.",
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    recommendedFor: "General tasks, writing, instruction following",
    isLocal: true,
  },
  {
    id: "qwen2.5:14b",
    name: "Qwen 2.5 (14B - Long Context)",
    provider: "ollama",
    profile: "LONG_CONTEXT",
    contextWindow: 131072,
    description: "Extended context window model engineered for large document comprehension and synthesis.",
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    recommendedFor: "Large file analysis, multi-document synthesis, and book queries",
    isLocal: true,
  },
  {
    id: "nexa-sandbox-demo",
    name: "NEXA Sandbox Demo Engine",
    provider: "demo",
    profile: "BALANCED",
    contextWindow: 8192,
    description: "Sandboxed preview engine for UI testing prior to configuring local Ollama or vLLM.",
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    recommendedFor: "Evaluation, UI testing, and setup verification",
    isLocal: true,
  },
];

export const PROFILE_METADATA: Record<
  ModelProfile,
  { label: string; icon: string; description: string; defaultModel: string }
> = {
  FAST: {
    label: "Fast",
    icon: "Zap",
    description: "Low latency, quick everyday answers and rapid formatting",
    defaultModel: "llama3.2:1b",
  },
  BALANCED: {
    label: "Balanced",
    icon: "Scale",
    description: "Balanced reasoning, general knowledge and helpful conversational flow",
    defaultModel: "llama3.2:3b",
  },
  REASONING: {
    label: "Reasoning",
    icon: "Brain",
    description: "Deep thinking, logic decomposition, mathematical deductions",
    defaultModel: "deepseek-r1:8b",
  },
  CODING: {
    label: "Coding",
    icon: "Code2",
    description: "Specialized in software architecture, syntax, debugging, and refactoring",
    defaultModel: "qwen2.5-coder:7b",
  },
  VISION: {
    label: "Vision",
    icon: "Eye",
    description: "Image analysis, diagrams, visual questions and layout inspection",
    defaultModel: "llama3.2-vision:11b",
  },
  LONG_CONTEXT: {
    label: "Long Context",
    icon: "FileSpreadsheet",
    description: "Extended window for large codebases, research papers and multi-file books",
    defaultModel: "qwen2.5:14b",
  },
};

export class ModelRegistry {
  private static models: Map<string, ModelDescriptor> = new Map(
    DEFAULT_MODELS.map((m) => [m.id, m])
  );

  public static getAll(): ModelDescriptor[] {
    return Array.from(this.models.values());
  }

  public static getById(id: string): ModelDescriptor | undefined {
    return this.models.get(id);
  }

  public static getByProfile(profile: ModelProfile): ModelDescriptor[] {
    return Array.from(this.models.values()).filter((m) => m.profile === profile);
  }

  public static registerModel(model: ModelDescriptor): void {
    this.models.set(model.id, model);
  }

  public static getRecommendedForProfile(profile: ModelProfile): string {
    return PROFILE_METADATA[profile]?.defaultModel || "llama3.2:3b";
  }
}

/* ------------------------------------------------------------------ */
/* Provider registry                                                   */
/* ------------------------------------------------------------------ */

/**
 * A model as reported by a provider's own discovery endpoint.
 *
 * Every optional capability is `null` when the provider did not report it.
 * NEXA never fills these in with a guess: `null` means "unknown / not claimed",
 * and the UI must render it as such.
 */
export interface DiscoveredModel {
  id: string;
  provider: ProviderType;
  /** Display name, or the raw id when the provider reports no separate name. */
  name: string;
  /** Provider-reported context window, or null when not reported. */
  contextWindow: number | null;
  /** null = provider does not advertise it to NEXA. */
  supportsStreaming: boolean | null;
  /** null = provider does not advertise it to NEXA. */
  supportsTools: boolean | null;
  /** null = provider does not advertise it to NEXA. */
  supportsVision: boolean | null;
  /** Provider-reported owning organisation, when present. */
  ownedBy?: string;
  /** ISO timestamp of the discovery call that produced this row. */
  discoveredAt: string;
}

export interface ProviderCapabilities {
  /** The adapter emits incremental token events. */
  streaming: boolean;
  /** true only when output is produced by a real model. */
  realInference: boolean;
  /** null = unknown / not claimed. */
  tools: boolean | null;
  /** null = unknown / not claimed. */
  vision: boolean | null;
}

export interface ProviderRegistration {
  id: ProviderType;
  name: string;
  /** Wire protocol the adapter speaks. */
  protocol: "ollama-native" | "openai-compatible" | "simulated";
  /** Whether the provider is configured and selectable right now. */
  enabled: boolean;
  /** Endpoint NEXA would call. Never contains a credential. */
  baseUrl: string | null;
  capabilities: ProviderCapabilities;
  /** Human sentence explaining the state. Shown verbatim in the UI. */
  note: string;
}

const BASE_PROVIDERS: ProviderRegistration[] = [
  {
    id: "ollama",
    name: "Ollama",
    protocol: "ollama-native",
    enabled: true,
    baseUrl: null,
    capabilities: { streaming: true, realInference: true, tools: null, vision: null },
    note: "Local engine. Reachability is probed live; model capabilities come from the discovered catalogue.",
  },
  {
    id: "openai_compatible",
    name: "OpenAI-compatible endpoint",
    protocol: "openai-compatible",
    enabled: true,
    baseUrl: null,
    capabilities: { streaming: true, realInference: true, tools: null, vision: null },
    note: "Any endpoint that speaks /v1/models and /v1/chat/completions (LM Studio, vLLM, ...).",
  },
  {
    id: "freellmapi",
    name: "FreeLLMAPI",
    protocol: "openai-compatible",
    enabled: false,
    baseUrl: null,
    capabilities: { streaming: true, realInference: true, tools: null, vision: null },
    note: "External provider. Disabled until FREELLMAPI_BASE_URL is configured.",
  },
  {
    id: "demo",
    name: "NEXA Demo Sandbox",
    protocol: "simulated",
    enabled: true,
    baseUrl: null,
    capabilities: { streaming: true, realInference: false, tools: null, vision: null },
    note: "Simulated preview engine: responses are canned text, not model output. Selected explicitly only.",
  },
];



/**
 * Provider-level registry.
 *
 * This is the existing registry file, extended rather than replaced:
 *
 *  - `ModelRegistry` still describes the curated local catalogue (`DEFAULT_MODELS`).
 *  - `ProviderRegistry` describes which *providers* exist, what they can actually
 *    do, and which models they reported. Discovered models are stored here with
 *    `null` metadata instead of being forced into `ModelDescriptor` (which would
 *    require inventing a context window or capability flag).
 *
 * Provider state for FreeLLMAPI is derived from the environment on every read,
 * because that is where its configuration lives.
 */
export class ProviderRegistry {
  private static providers: Map<ProviderType, ProviderRegistration> = new Map(
    BASE_PROVIDERS.map((p) => [p.id, p])
  );

  private static discovered: Map<ProviderType, DiscoveredModel[]> = new Map();

  /** All known providers, with environment-driven state applied. */
  public static getAll(): ProviderRegistration[] {
    return Array.from(this.providers.values()).map((p) =>
      p.id === "freellmapi" ? this.withEnvironmentState(p) : p
    );
  }

  public static get(id: ProviderType): ProviderRegistration | undefined {
    const provider = this.providers.get(id);
    if (!provider) return undefined;
    return provider.id === "freellmapi" ? this.withEnvironmentState(provider) : provider;
  }

  /** Replace or add a provider registration (used by tests and future adapters). */
  public static registerProvider(registration: ProviderRegistration): void {
    this.providers.set(registration.id, registration);
  }

  /** Record the models a provider reported from its own discovery endpoint. */
  public static setDiscoveredModels(id: ProviderType, models: DiscoveredModel[]): void {
    this.discovered.set(id, models);
  }

  public static getDiscoveredModels(id: ProviderType): DiscoveredModel[] {
    return this.discovered.get(id) ?? [];
  }

  public static getDiscoveredModel(id: ProviderType, modelId: string): DiscoveredModel | undefined {
    return this.getDiscoveredModels(id).find((m) => m.id === modelId);
  }

  public static clearDiscoveredModels(id?: ProviderType): void {
    if (id) {
      this.discovered.delete(id);
      return;
    }
    this.discovered.clear();
  }

  /**
   * FreeLLMAPI enablement is environment-driven: `FREELLMAPI_BASE_URL` is the
   * only switch. The API key is deliberately never exposed here.
   */
  private static withEnvironmentState(base: ProviderRegistration): ProviderRegistration {
    const baseUrl = (process.env.FREELLMAPI_BASE_URL ?? "").trim();
    const enabled = baseUrl.length > 0;
    return {
      ...base,
      enabled,
      baseUrl: enabled ? baseUrl : null,
      note: enabled
        ? "External OpenAI-compatible provider. Availability depends on the configured FreeLLMAPI installation and its provider pool; models are discovered at request time."
        : "Not configured. Set FREELLMAPI_BASE_URL (and optionally FREELLMAPI_API_KEY) in the server environment to enable it.",
    };
  }
}
