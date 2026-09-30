/**
 * NEXA AI Gateway — commit point (Phase 5).
 *
 *   before first non-empty token  →  retry / fallback allowed
 *   after  first non-empty token  →  committed: NO provider restart
 *
 * The second half is the whole point. A restart after content was delivered
 * re-streams the answer from the top, which is how the user saw the same
 * paragraph (and the same empty code fence) twice.
 *
 * The gateway, router, health store, retry policy, content accumulator and SSE
 * codec are all real here. Only the provider *transport* is scripted, because
 * a real second provider cannot be made to fail on demand.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  AIProvider,
  ChatChunk,
  ChatRequest,
  ChatResponse,
  GatewayProviderId,
} from "@/lib/gateway/types";
import { LegacyBackedProvider } from "@/lib/gateway/providers/legacy-adapter";
import { modelsFromIds } from "@/lib/gateway/providers/shared";
import type { ModelProvider, StreamEvent } from "@/lib/ai/types";
import { NexaGateway } from "@/lib/gateway/gateway";
import { GatewayHealthStore } from "@/lib/gateway/health";
import { GatewayModelRegistry } from "@/lib/gateway/registry";
import { GatewayError } from "@/lib/gateway/errors";

type Script = (emit: (e: StreamEvent) => void) => Promise<{
  fullText: string;
  reasoningText?: string;
  latencyMs: number;
}>;

/** A legacy adapter whose `generateStream` behaviour each test controls. */
class ScriptedAdapter implements ModelProvider {
  public readonly type = "custom" as const;
  public readonly baseUrl = "http://scripted.invalid";
  public calls = 0;

  constructor(
    public readonly id: string,
    public readonly name: string,
    private readonly script: Script
  ) {}

  public async testConnection() {
    return { ok: true, message: "scripted", models: ["m"], latencyMs: 1 };
  }
  public async listModels(): Promise<string[]> {
    return ["m"];
  }
  public generateStream(
    _options: unknown,
    emit: (event: StreamEvent) => void
  ): Promise<{ fullText: string; reasoningText?: string; latencyMs: number }> {
    this.calls += 1;
    return this.script(emit);
  }
}

class ScriptedProvider extends LegacyBackedProvider {
  public readonly requiresApiKey = false;
  public readonly name: string;
  protected readonly options = { streamingMode: "incremental" as const };

  constructor(
    public readonly id: GatewayProviderId,
    private readonly adapter: ScriptedAdapter,
    /** Lower sorts first in the real router, so the order is explicit here. */
    public readonly priority = 0,
    public readonly baseUrl = `http://${id}.invalid`
  ) {
    super();
    this.name = id;
  }
  protected createAdapter(): ModelProvider {
    return this.adapter;
  }
  public override configurationIssue(): string | null {
    return null;
  }
}

/** Swap the gateway's provider set for a scripted one. */
function useProviders(providers: AIProvider[]): void {
  vi.spyOn(NexaGateway, "context").mockReturnValue({
    providers,
    configs: providers.map((p) => ({
      id: p.id,
      name: p.name,
      enabled: true,
      baseUrl: p.baseUrl,
      requiresApiKey: p.requiresApiKey,
      priority: (p as ScriptedProvider).priority ?? 0,
      note: "scripted",
    })),
    byId: new Map(providers.map((p) => [p.id, p])),
  });
  // Discovery is not what these tests are about, so the registry is seeded
  // directly. The router still does the real candidate selection.
  for (const provider of providers) {
    GatewayModelRegistry.setModels(
      provider.id,
      modelsFromIds(provider.id, ["m"], {
        requiresApiKey: provider.requiresApiKey,
        supportsStreaming: true,
      })
    );
  }
}

const REQUEST: ChatRequest = {
  model: "auto",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
};

interface Collected {
  tokens: string[];
  error: string | null;
  done: ChatResponse | null;
}

async function drive(): Promise<Collected> {
  const tokens: string[] = [];
  let error: string | null = null;
  let done: ChatResponse | null = null;
  for await (const chunk of NexaGateway.streamChat(REQUEST) as AsyncIterable<ChatChunk>) {
    if (chunk.type === "token") tokens.push(chunk.content);
    if (chunk.type === "error") error = chunk.content;
    if (chunk.type === "done") done = chunk.data;
  }
  return { tokens, error, done };
}

beforeEach(() => {
  vi.restoreAllMocks();
  GatewayHealthStore.reset();
  GatewayModelRegistry.reset();
  vi.stubEnv("NEXA_GATEWAY_MAX_CANDIDATES", "4");
});

describe("Test A — failure before the first token: fallback is allowed", () => {
  it("falls back to the next provider and returns exactly one answer", async () => {
    const failing = new ScriptedAdapter("ollama", "Ollama scripted", async () => {
      throw new Error("fetch failed");
    });
    const working = new ScriptedAdapter("aihorde", "AI Horde scripted", async (emit) => {
      emit({ type: "token", content: "Hello " });
      emit({ type: "token", content: "world" });
      return { fullText: "Hello world", latencyMs: 5 };
    });

    useProviders([
      new ScriptedProvider("ollama", failing, 0),
      new ScriptedProvider("aihorde", working, 1),
    ]);

    const { tokens, done, error } = await drive();

    expect(failing.calls).toBeGreaterThanOrEqual(1);
    expect(working.calls).toBe(1);
    expect(error).toBeNull();
    expect(tokens.join("")).toBe("Hello world");
    expect(done?.provider).toBe("aihorde");
    expect(done?.routing.fallbackUsed).toBe(true);
  });

  it("treats a pre-token empty completion as a failure and falls back", async () => {
    // A provider that completes with nothing is a failure, not an answer.
    const empty = new ScriptedAdapter("ollama", "Ollama scripted", async () => ({ fullText: "", latencyMs: 1 }));
    const working = new ScriptedAdapter("aihorde", "AI Horde scripted", async (emit) => {
      emit({ type: "token", content: "real answer" });
      return { fullText: "real answer", latencyMs: 1 };
    });

    useProviders([
      new ScriptedProvider("ollama", empty, 0),
      new ScriptedProvider("aihorde", working, 1),
    ]);

    const { tokens } = await drive();
    expect(tokens.join("")).toBe("real answer");
    expect(working.calls).toBe(1);
  });
});

describe("Test B — failure after the first token: NO provider restart", () => {
  it("reports the failure and never re-streams the answer", async () => {
    // Provider A emits one token, then dies. Provider B would happily answer.
    const dying = new ScriptedAdapter("ollama", "Ollama scripted", async (emit) => {
      emit({ type: "token", content: "Hello" });
      throw new Error("connection reset");
    });
    const second = new ScriptedAdapter("aihorde", "AI Horde scripted", async (emit) => {
      emit({ type: "token", content: "Hello from provider B" });
      return { fullText: "Hello from provider B", latencyMs: 5 };
    });

    useProviders([
      new ScriptedProvider("ollama", dying, 0),
      new ScriptedProvider("aihorde", second, 1),
    ]);

    const { tokens, error, done } = await drive();

    // The client got the partial text exactly once...
    expect(tokens).toEqual(["Hello"]);
    expect(tokens.join("")).not.toContain("HelloHello");
    // ...an honest failure, not a second answer...
    expect(error).toContain("connection reset");
    expect(done).toBeNull();
    // ...and provider B was never contacted at all.
    expect(second.calls).toBe(0);
  });

  it("does not restart even when the failure category looks transient", async () => {
    const dying = new ScriptedAdapter("ollama", "Ollama scripted", async (emit) => {
      emit({ type: "token", content: "Partial answer" });
      // A timeout is the most "retryable" category there is.
      throw new GatewayError("ProviderTimeout", "upstream timed out", {
        category: "timeout",
        provider: "ollama",
      });
    });
    const second = new ScriptedAdapter("aihorde", "AI Horde scripted", async () => ({
      fullText: "second",
      latencyMs: 1,
    }));

    useProviders([
      new ScriptedProvider("ollama", dying, 0),
      new ScriptedProvider("aihorde", second, 1),
    ]);

    const { tokens, error } = await drive();
    expect(tokens).toEqual(["Partial answer"]);
    expect(error).toContain("upstream timed out");
    expect(second.calls).toBe(0);
  });

  it("does not let a repeated (snapshot) frame re-deliver committed content", async () => {
    // A provider that resends the whole reply in every frame is folded by the
    // content accumulator, so the client still sees each character once.
    const chatty = new ScriptedAdapter("ollama", "Ollama scripted", async (emit) => {
      const snapshots = ["Hel", "Hello", "Hello world"];
      for (const snapshot of snapshots) {
        emit({ type: "token", content: snapshot });
      }
      return { fullText: "Hello world", latencyMs: 1 };
    });

    useProviders([new ScriptedProvider("ollama", chatty)]);

    const { tokens, done } = await drive();
    expect(tokens.join("")).toBe("Hello world");
    expect(done?.content).toBe("Hello world");
  });

  it("commits on the first non-empty token, not on an empty or action frame", async () => {
    // An action frame (and an empty token) must NOT commit the stream: before
    // any real content there is still nothing to duplicate.
    const flaky = new ScriptedAdapter("ollama", "Ollama scripted", async (emit) => {
      emit({ type: "action", content: "connecting" });
      emit({ type: "token", content: "" });
      throw new Error("failed before any content");
    });
    const working = new ScriptedAdapter("aihorde", "AI Horde scripted", async (emit) => {
      emit({ type: "token", content: "recovered" });
      return { fullText: "recovered", latencyMs: 1 };
    });

    useProviders([
      new ScriptedProvider("ollama", flaky, 0),
      new ScriptedProvider("aihorde", working, 1),
    ]);

    const { tokens, done } = await drive();
    // Fallback happened: nothing real had been committed yet.
    expect(tokens.join("")).toBe("recovered");
    expect(done?.provider).toBe("aihorde");
  });
});
