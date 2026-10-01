import { NextRequest } from "next/server";
import { db } from "@/db";
import { conversations, messages } from "@/db/schema";
import { Attachment, Citation, ModelProfile, ProviderType, ToolCallItem } from "@/types";
import { InferenceService } from "@/lib/ai/inference";
import { ModelRouter } from "@/lib/ai/router";
import { isProviderError } from "@/lib/ai/provider-errors";
import { describeProvider } from "@/lib/ai/providers/factory";
import { NexaGateway } from "@/lib/gateway/gateway";
import { GatewayError } from "@/lib/gateway/errors";
import { RAGRetriever } from "@/lib/rag/retriever";
import { WebSearchService } from "@/lib/search/web-search";
import { ToolExecutor } from "@/lib/tools/executor";
import { MemoryService } from "@/lib/memory/memory-service";
import { AuditLogger } from "@/lib/security/audit";
import { requireUser } from "@/lib/auth/guard";
import { ApiError, toErrorResponse } from "@/lib/api/errors";
import { checkChatSessionLimit, rateLimitHeaders } from "@/lib/gateway/rate-limit-guard";
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
    // Runs first, and is the reason the limiter below can trust `user.id`:
    // an unauthenticated request is rejected here and never reaches the store,
    // so it cannot spend a signed-in user's quota.
    const user = await requireUser(req);

    // ---- Rate limiting (Phase 5.2) ----
    // Placed after authentication and BEFORE anything expensive: before the
    // body is parsed, before the conversation/user-message rows are written,
    // and long before `NexaGateway.streamChat`. A throttled request therefore
    // performs no database write and starts no provider work.
    //
    // Charging before body validation is deliberate. A malformed body still
    // costs quota, so an attacker cannot hammer this endpoint with garbage to
    // force unbounded conversation/message inserts, and a validation failure
    // is not a way to obtain free attempts. The validation still runs before
    // any provider call, so malformed input never reaches a model.
    const decision = await checkChatSessionLimit(user.id, req.headers);
    if (!decision.allowed) {
      // A limiter-store outage is a 503, never a 429: reporting an outage as a
      // throttle would tell every client to slow down and would hide a real
      // incident behind ordinary-looking throttling.
      const storeDown = decision.deniedByStoreFailure;
      return Response.json(
        {
          error: storeDown
            ? "Chat is temporarily unavailable. Please retry shortly."
            : "You are sending messages too quickly. Please wait a moment and try again.",
          code: storeDown ? "UPSTREAM_UNAVAILABLE" : "RATE_LIMITED",
        },
        {
          status: storeDown ? 503 : 429,
          // Quota headers are omitted for an outage: there is no meaningful
          // quota to report while the store cannot be read.
          headers: rateLimitHeaders(decision),
        }
      );
    }

    // ---- Body validation (never reaches a provider) ----
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
        // NEXA is served by FreeLLMAPI, so a new conversation is labelled with
        // the configured FreeLLMAPI model rather than an Ollama model id. The
        // routing decision below still chooses the model actually sent.
        model: requestedModel || (process.env.FREELLMAPI_MODEL ?? "").trim() || "auto",
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
    // ---- Streaming (SSE) ----
    // One AbortController bridges the client's disconnect to the provider.
    // It is created *before* the stream opens so no request can slip through
    // without cancellation support, and it is passed to the gateway below.
    const clientAbort = new AbortController();
    const onClientAbort = () => clientAbort.abort();
    // `req.signal` is already aborted when the client has gone away, so the
    // listener is registered with `{ once: true }` and removed when it fires.
    req.signal.addEventListener("abort", onClientAbort, { once: true });

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

        // 7. Stream from the active model provider, through the NEXA gateway.
        //
        // The model id is pinned to the user's configured provider so the
        // gateway cannot send an Ollama profile model to a different provider,
        // while still being free to fall back if that provider is down.
        await sendEvent({
          type: "action",
          content: `Generating response from the ${describeProvider(activeProvider)}...`,
        });

        // Pinned when the legacy provider maps to a gateway provider id;
        // otherwise left to the gateway's own deterministic `auto` routing.
        const pinnedProvider = routeDecision.modelId
          ? pinProviderId(activeProvider)
          : null;
        const gatewayModel =
          routeDecision.modelId && pinnedProvider
            ? `${pinnedProvider}/${routeDecision.modelId}`
            : "auto";

        let selectedModel: string | null = null;
        let selectedProvider: string | null = null;
        let routingFallbackUsed = false;
        let failure: unknown = null;

        for await (const ev of NexaGateway.streamChat({
          model: gatewayModel,
          messages: inputMessages.map((m) => ({ role: m.role, content: m.content })),
          systemPrompt: fullSystemPrompt,
          stream: true,
          // Phase 5.2: propagate the client's disconnect to the provider.
          // Without this, a client could start an inference, immediately abort
          // the fetch, and leave the model generating to completion — paying
          // full token cost for output nobody will ever read. The gateway and
          // its providers already accept `signal`; the route simply was not
          // passing one.
          //
          // Note this is a *cost* control, not a quota control. Quota is
          // charged above, before any of this, and is deliberately NOT
          // refunded on abort: otherwise a client could start expensive work
          // and abort to obtain unlimited effective attempts.
          signal: clientAbort.signal,
        })) {
          if (ev.type === "token" && ev.content) {
            fullAssistantText += ev.content;
            await sendEvent({ type: "token", content: ev.content });
          } else if (ev.type === "reasoning" && ev.content) {
            fullReasoningText += ev.content;
            await sendEvent({ type: "reasoning", content: ev.content });
          } else if (ev.type === "done") {
            selectedModel = ev.data.model;
            selectedProvider = ev.data.provider;
            routingFallbackUsed = ev.data.routing.fallbackUsed;
          } else if (ev.type === "error") {
            failure = ev.data ?? new Error(ev.content);
          }
        }

        if (failure) {
          throw failure;
        }

        const latencyMs = Date.now() - start;
        const assistantMessageId = `msg_ast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

        // The model that actually served the request (never a guess). Taken from
        // the gateway's routing record, which is the only trustworthy source.
        const modelUsed = selectedModel ?? routeDecision.modelId ?? "unknown";
        const providerId = selectedProvider ?? activeProvider;

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
            provider: providerId,
            latencyMs,
            // The gateway has no simulated provider, so a response reaching this
            // point was produced by a real model. Kept for client compatibility.
            isDemo: false,
            fallbackUsed: routingFallbackUsed,
          },
        });

        await AuditLogger.log("chat_completion", {
          userId: user.id,
          conversationId: convId,
          model: modelUsed,
          provider: providerId,
          isDemo: false,
          latencyMs,
        });
      } catch (err: unknown) {
        // Gateway failures are already normalized, credential-free and
        // classified, so the classification is forwarded rather than flattened
        // into a generic message the UI cannot act on.
        const gatewayError = err instanceof GatewayError ? err : null;
        const errorMsg = gatewayError
          ? gatewayError.message
          : isProviderError(err)
            ? err.message
            : "An unexpected error occurred.";
        await sendEvent({
          type: "error",
          content: errorMsg,
          ...(gatewayError
            ? {
                data: {
                  provider_error: gatewayError.code,
                  provider: gatewayError.provider,
                  category: gatewayError.category,
                },
              }
            : isProviderError(err)
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

/**
 * Map NEXA's legacy `ProviderType` onto a gateway provider id, for pinning.
 *
 * `custom` is the one lossy case: the legacy type does not record which of the
 * compatible providers was meant, so it is not pinned at all and the gateway
 * routes it. That is the safe default — guessing `openai_compatible` could send
 * a request to a provider the user did not select.
 */
function pinProviderId(provider: ProviderType): string | null {
  switch (provider) {
    case "ollama":
    case "openai_compatible":
    case "vllm":
    case "freellmapi":
      return provider;
    default:
      // "custom" and "demo" are not gateway provider ids.
      return null;
  }
}
