import { GenerateOptions, ModelProvider, StreamEvent } from "../types";

export class OpenAICompatibleProvider implements ModelProvider {
  public id = "openai_compatible";
  public name = "OpenAI-Compatible Local Endpoint";
  public type = "openai_compatible" as const;
  public baseUrl: string;
  public apiKey?: string;

  constructor(baseUrl?: string, apiKey?: string) {
    this.baseUrl = baseUrl || process.env.OPENAI_COMPATIBLE_URL || "http://localhost:1234/v1";
    if (this.baseUrl.endsWith("/")) {
      this.baseUrl = this.baseUrl.slice(0, -1);
    }
    this.apiKey = apiKey || process.env.OPENAI_COMPATIBLE_KEY;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
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

      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.getHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const latencyMs = Date.now() - start;
      if (!res.ok) {
        return {
          ok: false,
          message: `Endpoint returned HTTP ${res.status}: ${res.statusText}`,
          latencyMs,
        };
      }

      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const modelNames = (data.data || []).map((m) => m.id);

      return {
        ok: true,
        message: `Connected to endpoint (${modelNames.length} models reported)`,
        models: modelNames,
        latencyMs,
      };
    } catch (err: unknown) {
      const latencyMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `Endpoint unreachable at ${this.baseUrl}: ${errorMsg}`,
        latencyMs,
      };
    }
  }

  public async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.getHeaders(),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      return (data.data || []).map((m) => m.id);
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
      temperature: options.temperature ?? 0.7,
      top_p: options.topP ?? 0.9,
      max_tokens: options.maxTokens ?? 4096,
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
      signal: options.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`OpenAI-compatible request failed (${res.status}): ${errText}`);
    }

    if (!res.body) {
      throw new Error("No response body received from endpoint");
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
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === "[DONE]") break;

          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.reasoning_content) {
              const rToken = delta.reasoning_content;
              reasoningText += rToken;
              emitEvent({ type: "reasoning", content: rToken });
            }
            if (delta?.content) {
              const token = delta.content;
              fullText += token;
              emitEvent({ type: "token", content: token });
            }
          } catch {
            // Incomplete frame
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
}
