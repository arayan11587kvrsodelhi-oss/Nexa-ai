import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { toolCalls } from "@/db/schema";
import { ToolRegistry } from "@/lib/tools/registry";
import { ToolExecutor } from "@/lib/tools/executor";
import { requireUser } from "@/lib/auth/guard";
import { toErrorResponse, ApiError } from "@/lib/api/errors";
import { checkSessionLimit, rateLimitHeaders } from "@/lib/gateway/rate-limit-guard";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const tools = ToolRegistry.getAll();
    return NextResponse.json({ tools });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    // Phase 5.1 audit — this route is rate limited, unlike GET below and unlike
    // most other `/api/*` routes, for three concrete reasons found by reading
    // the implementation rather than assuming:
    //
    //  1. `web_search` calls WebSearchService, which spends a *metered*
    //     Tavily/Brave credential (web-search.ts) or a SearXNG round trip.
    //  2. `file_search` runs `ilike(documents.rawContent, %q%)` — an
    //     unindexed full scan of the document corpus on every call.
    //  3. Both are reachable in a loop with no other bound, so one account can
    //     convert a session into unbounded third-party spend and database load.
    //
    // GET is deliberately NOT limited: it returns a static in-memory registry
    // and touches neither the network nor the database, so a limit there would
    // cost a database write on every page load to constrain nothing.
    //
    // Authentication already resolved `user`, so the bucket is keyed by a
    // server-derived id and an unauthenticated caller never reaches the limiter.
    const decision = await checkSessionLimit("tools", user.id);
    if (!decision.allowed) {
      return NextResponse.json(
        {
          error: decision.deniedByStoreFailure
            ? "The gateway is temporarily unable to accept requests. Please retry shortly."
            : "Too many tool invocations. Please wait a moment and try again.",
          code: "RATE_LIMITED",
        },
        { status: 429, headers: rateLimitHeaders(decision) }
      );
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw ApiError.badRequest("A JSON body is required.");
    }
    const { toolName, input = {}, conversationId } = body;

    if (!toolName || typeof toolName !== "string") {
      throw ApiError.badRequest("Tool name is required.");
    }

    // The tool may only run against a conversation the caller owns.
    if (conversationId) {
      const { conversations } = await import("@/db/schema");
      const owned = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)))
        .limit(1);
      if (owned.length === 0) {
        return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
      }
    }

    const result = await ToolExecutor.execute(toolName, input, conversationId, user.id);

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}
