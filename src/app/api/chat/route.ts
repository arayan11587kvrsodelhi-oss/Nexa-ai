import { NextRequest } from "next/server";
import { db } from "@/db";
import { conversations, messages } from "@/db/schema";
import { Attachment, Citation, ModelProfile, ToolCallItem } from "@/types";
import { InferenceService } from "@/lib/ai/inference";
import { ModelRouter } from "@/lib/ai/router";
import { isProviderError } from "@/lib/ai/provider-errors";
import { describeProvider } from "@/lib/ai/providers/factory";
import { RAGRetriever } from "@/lib/rag/retriever";
import { WebSearchService } from "@/lib/search/web-search";
import { ToolExecutor } from "@/lib/tools/executor";
import { MemoryService } from "@/lib/memory/memory-service";
import { AuditLogger } from "@/lib/security/audit";
import { requireUser } from "@/lib/auth/guard";
import { ApiError, toErrorResponse } from "@/lib/api/errors";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

interface ChatRequestBody {
  conversationId?: string;
  messages: Array<{
    role: "user" | "assistant" | "system" | "tool";
    content: string;
  }>;
  model?: string;
  profile?: ModelProfile;
  toolsEnabled?: boolean;
  webSearchEnabled?: boolean;
  attachments?: Attachment[];
  systemPrompt?: string;
  projectId?: string;
}

export async function POST(req: NextRequest) {
  const start = Date.now();

  try {
    // ---- Authentication (401 when no valid session) ----
    const user = await requireUser(req);

    const body = (await req.json()) as ChatRequestBody;
    const {
      messages: inputMessages = [],
      model: requestedModel,
      profile: requestedProfile,
      toolsEnabled = true,
      webSearchEnabled = false,
      attachments = [],
      systemPrompt: userSystemPrompt,
      projectId,
    } = body;

    if (!inputMessages || inputMessages.length === 0) {
      return new Response(JSON.stringify({ error: "Messages array is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const lastUserMsg = inputMessages[inputMessages.length - 1];
    const userPrompt = lastUserMsg.content || "";

    // Ensure or create conversation
    let convId = body.conversationId;
    if (!convId) {
      convId = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const title =
        userPrompt.slice(0, 48).trim() || "New Workspace Session";
      await db.insert(conversations).values({
        id: convId,
        userId: user.id,
        title,
        model: requestedModel || "llama3.2:3b",
        profile: requestedProfile || "BALANCED",
        projectId: projectId || null,
      });
    } else {
      // Ownership check: a user may only append to their own conversation.
      // An id that exists but belongs to someone else is treated as not found.
      const existing = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(eq(conversations.id, convId), eq(conversations.userId, user.id))
        )
        .limit(1);
      if (existing.length === 0) {
        throw ApiError.notFound("Conversation not found");
      }
    }

    // Save user message to DB
    const userMessageId = `msg_usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await db.insert(messages).values({
      id: userMessageId,
      conversationId: convId,
      role: "user",
      content: userPrompt,
      attachments: attachments.map((a) => ({
        id: a.id,
        name: a.name,
        size: a.size,
        mimeType: a.mimeType,
        url: a.url,
      })),
    });

    // Check for explicit memory directive
    const detectedMemory = MemoryService.detectExplicitMemoryRequest(userPrompt);
    if (detectedMemory) {
      try {
        await MemoryService.storeMemory(user.id, detectedMemory, "preference", "explicit");
      } catch (err) {
        console.warn("Failed to store detected memory:", err);
      }
    }

    // Model Routing
    //
    // The active provider is resolved from the same configuration the inference
    // service will use (no network I/O), so a model id is never routed for one
    // provider and then sent to another — e.g. an Ollama profile model must not
    // be forwarded to FreeLLMAPI.
    const activeProvider = await InferenceService.resolveActiveProviderType(user.id);
    const routeDecision = ModelRouter.route(
      userPrompt,
      requestedProfile,
      requestedModel,
      attachments,
      activeProvider
    );

    // Prepare streaming response
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    const sendEvent = async (event: Record<string, unknown>) => {
      try {
        await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      } catch {
        // Stream may have closed
      }
    };

    // Begin background processing
    (async () => {
      let fullAssistantText = "";
      let fullReasoningText = "";
      const collectedCitations: Citation[] = [];
      const collectedToolCalls: ToolCallItem[] = [];

      try {
        // 1. Emit routing event
        await sendEvent({
          type: "action",
          content: routeDecision.modelId
            ? `Model profile: ${routeDecision.profile} (${routeDecision.modelId}) via ${describeProvider(activeProvider)} • ${routeDecision.reason}`
            : `Model profile: ${routeDecision.profile} via ${describeProvider(activeProvider)} • ${routeDecision.reason}`,
        });

        // 2. RAG Document Retrieval if attachments or project context exist or question is about docs
        let ragContext = "";
        const isDocQuestion =
          attachments.length > 0 ||
          projectId !== undefined ||
          /document|file|pdf|code|extract|summarize|page|chapter/i.test(userPrompt);

        if (isDocQuestion) {
          await sendEvent({
            type: "action",
            content: "Searching local document intelligence index...",
          });

          const relevantChunks = await RAGRetriever.retrieveRelevantChunks(
            userPrompt,
            {
              documentIds: attachments.length > 0 ? attachments.map((a) => a.id) : undefined,
              projectId,
              userId: user.id,
              topK: 3,
            }
          );

          if (relevantChunks.length > 0) {
            await sendEvent({
              type: "action",
              content: `Retrieved ${relevantChunks.length} relevant context chunks with verified citations.`,
            });

            ragContext = "\n\n[RELEVANT LOCAL FILE EXCERPTS]:\n";
            for (const chunk of relevantChunks) {
              ragContext += `\n--- SOURCE: ${chunk.documentName} (Section ${chunk.chunkIndex + 1}) ---\n${chunk.content}\n`;
              collectedCitations.push(chunk.citation);
              await sendEvent({
                type: "citation",
                data: chunk.citation,
              });
            }
          }
        }

        // 3. Web Search if enabled
        let webContext = "";
        if (webSearchEnabled) {
          await sendEvent({
            type: "action",
            content: `Initiating web search for "${userPrompt.slice(0, 40)}"...`,
          });

          const searchRes = await WebSearchService.search(userPrompt, 3);
          if (searchRes.error) {
            await sendEvent({
              type: "action",
              content: `Notice: ${searchRes.error}`,
            });
          } else if (searchRes.results.length > 0) {
            await sendEvent({
              type: "action",
              content: `Found ${searchRes.results.length} verified web sources.`,
            });
            webContext = "\n\n[LIVE WEB SEARCH RESULTS]:\n";
            for (const res of searchRes.results) {
              webContext += `\nSource: [${res.title}](${res.url})\nSnippet: ${res.snippet}\n`;
            }
            for (const cit of searchRes.citations) {
              collectedCitations.push(cit);
              await sendEvent({
                type: "citation",
                data: cit,
              });
            }
          }
        }

        // 4. Calculator / Tool execution if user prompt has math expression and toolsEnabled
        if (toolsEnabled && /calculate|compute|sqrt|\b[0-9]{2,}\s*[+\-*/^%]\s*[0-9]{2,}\b/i.test(userPrompt)) {
          const mathMatch = userPrompt.match(/[-0-9+*/^().\s]{4,}/);
          if (mathMatch) {
            const expr = mathMatch[0].trim();
            await sendEvent({
              type: "action",
              content: `Executing tool 'calculator' with expression: ${expr}`,
            });
            const calcRes = await ToolExecutor.execute("calculator", { expression: expr }, convId, user.id);
            collectedToolCalls.push({
              id: `tool_${Date.now()}`,
              name: "calculator",
              input: { expression: expr },
              output: calcRes.result || calcRes.error,
              status: calcRes.status === "failed" ? "failed" : "success",
            });
          }
        }

        // 5. Active User Memories
        const activeMemories = await MemoryService.getActiveMemories(user.id, 6);
        const memoryContext = MemoryService.formatForPrompt(activeMemories);

        // 6. Build combined system prompt
        const baseSystem =
          userSystemPrompt ||
          "You are NEXA AI, an honest, private, highly capable personal AI assistant running locally. Prioritize accuracy, truthfulness, clean markdown, and honest capability reporting. Never fabricate citations or claim external data exists when it does not.";

        const fullSystemPrompt = `${baseSystem}${memoryContext}${ragContext}${webContext}`;

        // 7. Stream from active model provider
        await sendEvent({
          type: "action",
          content: `Generating response from the ${describeProvider(activeProvider)}...`,
        });

        const genResult = await InferenceService.streamChat(
          user.id,
          {
            model: routeDecision.modelId,
            messages: inputMessages,
            systemPrompt: fullSystemPrompt,
          },
          async (ev) => {
            if (ev.type === "token" && ev.content) {
              fullAssistantText += ev.content;
              await sendEvent({ type: "token", content: ev.content });
            } else if (ev.type === "reasoning" && ev.content) {
              fullReasoningText += ev.content;
              await sendEvent({ type: "reasoning", content: ev.content });
            }
          }
        );

        const latencyMs = Date.now() - start;
        const assistantMessageId = `msg_ast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

        // The model that actually served the request (never a guess).
        const modelUsed = genResult.isDemo
          ? "NEXA Demo Sandbox Engine"
          : genResult.modelUsed || routeDecision.modelId;

        // Save assistant message to DB
        await db.insert(messages).values({
          id: assistantMessageId,
          conversationId: convId,
          role: "assistant",
          content: fullAssistantText,
          reasoningContent: fullReasoningText || null,
          citations: collectedCitations,
          toolCalls: collectedToolCalls,
          modelUsed,
          latencyMs,
        });

        // Update conversation timestamp
        await db
          .update(conversations)
          .set({ updatedAt: new Date() })
          .where(eq(conversations.id, convId));

        await sendEvent({
          type: "done",
          data: {
            messageId: assistantMessageId,
            conversationId: convId,
            modelUsed,
            provider: genResult.providerId,
            latencyMs,
            isDemo: genResult.isDemo,
          },
        });

        await AuditLogger.log("chat_completion", {
          userId: user.id,
          conversationId: convId,
          model: modelUsed,
          provider: genResult.providerId,
          isDemo: genResult.isDemo,
          latencyMs,
        });
      } catch (err: unknown) {
        // Provider failures stay provider failures: the message is the
        // normalized, credential-free explanation, and the code lets the UI
        // distinguish "provider unavailable" from "demo output".
        const errorMsg =
          err instanceof Error ? err.message : "An unexpected error occurred.";
        await sendEvent({
          type: "error",
          content: errorMsg,
          ...(isProviderError(err)
            ? { data: { provider_error: err.code, provider: err.providerId } }
            : {}),
        });
      } finally {
        await writer.close();
      }
    })();

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (err: unknown) {
    return toErrorResponse(err);
  }
}
