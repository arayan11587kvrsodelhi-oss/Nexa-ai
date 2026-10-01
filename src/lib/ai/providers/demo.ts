import { GenerateOptions, ModelProvider, StreamEvent } from "../types";

export class DemoSandboxProvider implements ModelProvider {
  public id = "demo";
  public name = "NEXA Demo Sandbox (Simulated)";
  public type = "demo" as const;
  public baseUrl = "internal://nexa-sandbox";

  public async testConnection(): Promise<{
    ok: boolean;
    message: string;
    models?: string[];
    latencyMs?: number;
  }> {
    return {
      ok: true,
      message: "NEXA UI Sandbox Engine active (DEMO MODE)",
      models: ["nexa-sandbox-demo"],
      latencyMs: 5,
    };
  }

  public async listModels(): Promise<string[]> {
    return ["nexa-sandbox-demo"];
  }

  public async generateStream(
    options: GenerateOptions,
    emitEvent: (event: StreamEvent) => void
  ): Promise<{ fullText: string; reasoningText?: string; latencyMs: number }> {
    const start = Date.now();
    const lastMsg = options.messages[options.messages.length - 1]?.content || "";
    const lower = lastMsg.toLowerCase();

    // Emit initial reasoning reflection if reasoning model requested
    const isReasoning =
      options.model.includes("deepseek") ||
      options.model.includes("reasoning") ||
      lower.includes("why") ||
      lower.includes("how");

    let reasoningText = "";
    if (isReasoning) {
      const thoughts = [
        "Analyzing user inquiry in NEXA Private AI Workspace...\n",
        "Inspecting context, active memory, and tool permissions...\n",
        "Synthesizing structured response adhering to configured privacy constraints...\n",
      ];
      for (const t of thoughts) {
        reasoningText += t;
        emitEvent({ type: "reasoning", content: t });
        await new Promise((r) => setTimeout(r, 60));
      }
    }

    // Generate responsive demo text
    let responseText = "";

    if (lower.includes("hello") || lower.includes("hi") || lower.includes("hey")) {
      responseText = `**Hello! Welcome to NEXA AI — Your Private AI Workspace.**

[DEMO MODE NOTICE]: You are currently connected to the local UI Sandbox Engine, which returns canned text rather than real model output. Responses are not produced by a model.

To use real inference, configure FreeLLMAPI on the server:
1. Set \`FREELLMAPI_BASE_URL\` to your FreeLLMAPI installation, and \`FREELLMAPI_API_KEY\` if it requires one.
2. Set \`FREELLMAPI_MODEL\` to a model id your installation reports via \`GET /v1/models\`.
3. Restart NEXA, then open Models to confirm the engine is reachable.

Note: when an external AI provider is configured, prompts and relevant content are sent to it for inference. Your stored workspace data stays in your configured PostgreSQL database.

How can I assist you with your code, documents, or research today?`;
    } else if (
      lower.includes("code") ||
      lower.includes("function") ||
      lower.includes("typescript") ||
      lower.includes("python")
    ) {
      responseText = `Here is a clean, type-safe implementation suited for local execution:

\`\`\`typescript
// NEXA AI - Local Stream Handler Pattern
export interface StreamChunk {
  id: string;
  token: string;
  timestamp: number;
}

export async function processStream(
  stream: ReadableStream<Uint8Array>,
  onToken: (token: string) => void
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let accumulated = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      accumulated += text;
      onToken(text);
    }
  } finally {
    reader.releaseLock();
  }

  return accumulated;
}
\`\`\`

### Architectural Highlights:
- **Zero Host Leakage**: All streams are processed in-memory.
- **Resource Efficient**: Direct \`Uint8Array\` decoding without buffer bloating.
- **Graceful Termination**: Uses \`try...finally\` to ensure lock release.`;
    } else if (lower.includes("table") || lower.includes("compare")) {
      responseText = `Here is a capability comparison across primary open-source models supported by NEXA AI:

| Profile | Recommended Model | Hardware VRAM | Ideal Workload |
| :--- | :--- | :--- | :--- |
| **Fast** | \`llama3.2:1b\` | ~2 GB | Quick answers, summarization, edge devices |
| **Balanced** | \`llama3.2:3b\` / \`mistral:7b\` | ~4-6 GB | General discussion, document QA, daily assistant |
| **Reasoning** | \`deepseek-r1:8b\` | ~8 GB | Math theorems, logic puzzles, step-by-step proofs |
| **Coding** | \`qwen2.5-coder:7b\` | ~6-8 GB | Fullstack programming, refactoring, test suites |
| **Vision** | \`llama3.2-vision:11b\` | ~12 GB | Chart reading, OCR, diagram comprehension |
| **Long Context**| \`qwen2.5:14b\` (128k) | ~14 GB | Multi-file codebases, book-length document RAG |

*These are illustrative local-model profiles. NEXA AI is served by FreeLLMAPI; the models actually available are those your configured installation reports via \`GET /v1/models\`.*`;
    } else {
      responseText = `I have received your request:

> "${lastMsg.slice(0, 160)}${lastMsg.length > 160 ? "..." : ""}"

**NEXA AI** is a local-first workspace. Your stored workspace data remains in your configured PostgreSQL database. If an external AI provider is configured, prompts and relevant content may be sent to that provider for inference.

- **Status**: Demo Sandbox active (canned text, not model output)
- **Real inference**: configure FreeLLMAPI on the server (\`FREELLMAPI_BASE_URL\`, \`FREELLMAPI_API_KEY\`, \`FREELLMAPI_MODEL\`).
- **Available Capabilities**: RAG Document Intelligence, Monaco Coding Workspace, Multi-step Autonomous Agents, and Memory Management.

Would you like me to inspect code, parse documents, run a calculation, or help you configure your AI provider?`;
    }

    // Stream tokens in small chunks
    const words = responseText.split(" ");
    for (let i = 0; i < words.length; i++) {
      const chunk = (i === 0 ? "" : " ") + words[i];
      emitEvent({ type: "token", content: chunk });
      await new Promise((r) => setTimeout(r, 20));
    }

    emitEvent({ type: "done" });
    return {
      fullText: responseText,
      reasoningText: reasoningText || undefined,
      latencyMs: Date.now() - start,
    };
  }
}
