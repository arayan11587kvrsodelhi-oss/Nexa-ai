import { GenerateOptions, ModelProvider, StreamEvent } from "../types";

export class OllamaProvider implements ModelProvider {
  public id = "ollama";
  public name = "Ollama Local Engine";
  public type = "ollama" as const;
  public baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl =
      baseUrl || process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    // Strip trailing slash
    if (this.baseUrl.endsWith("/")) {
      this.baseUrl = this.baseUrl.slice(0, -1);
    }
  }

  public async testConnection(): Promise<{
    ok: boolean;
    message: string;
    models?: string[];
    latencyMs?: number;
  }> {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);

      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const latencyMs = Date.now() - start;
      if (!res.ok) {
        return {
          ok: false,
          message: `Ollama returned HTTP status ${res.status}: ${res.statusText}`,
          latencyMs,
        };
      }

      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const modelNames = (data.models || []).map((m) => m.name);

      return {
        ok: true,
        message: `Connected to Ollama (${modelNames.length} models installed)`,
        models: modelNames,
        latencyMs,
      };
    } catch (err: unknown) {
      const latencyMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `Local AI engine unavailable: Ollama is not reachable at ${this.baseUrl} (${errorMsg}). Start Ollama with 'ollama serve' or configure another endpoint.`,
        latencyMs,
      };
    }
  }

  public async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      return (data.models || []).map((m) => m.name);
    } catch {
      return [];
    }
  }

  public async generateStream(
    options: GenerateOptions,
    emitEvent: (event: StreamEvent) => void
  ): Promise<{ fullText: string; reasoningText?: string; latencyMs: number }> {
    const start = Date.now();
    const payload = {
      model: options.model,
      messages: [
        ...(options.systemPrompt
          ? [{ role: "system", content: options.systemPrompt }]
          : []),
        ...options.messages,
      ],
      stream: true,
      options: {
        temperature: options.temperature ?? 0.7,
        top_p: options.topP ?? 0.9,
        num_predict: options.maxTokens ?? 4096,
      },
    };

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: options.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`Ollama chat request failed (${res.status}): ${errText}`);
    }

    if (!res.body) {
      throw new Error("No response body received from Ollama");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let fullText = "";
    let reasoningText = "";
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            // Ollama can stream thinking/reasoning content (e.g. DeepSeek R1 via thinking tags or message.reasoning_content)
            if (parsed.message?.reasoning_content) {
              const rToken = parsed.message.reasoning_content;
              reasoningText += rToken;
              emitEvent({ type: "reasoning", content: rToken });
            }

            if (parsed.message?.content) {
              const token = parsed.message.content;
              fullText += token;
              emitEvent({ type: "token", content: token });
            }

            if (parsed.done) {
              // Generation complete
            }
          } catch {
            // Ignore incomplete line parse
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    emitEvent({ type: "done" });
    return {
      fullText,
      reasoningText: reasoningText || undefined,
      latencyMs: Date.now() - start,
    };
  }

  public async embed(text: string, model = "nomic-embed-text"): Promise<number[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: text }),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { embedding?: number[] };
      return data.embedding || [];
    } catch {
      return [];
    }
  }
}
