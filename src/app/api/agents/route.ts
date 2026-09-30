import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { agentRuns } from "@/db/schema";
import { AgentOrchestrator } from "@/lib/agents/orchestrator";
import { requireUser } from "@/lib/auth/guard";
import { ApiError, toErrorResponse } from "@/lib/api/errors";
import { checkAgentSessionLimit, rateLimitHeaders } from "@/lib/gateway/rate-limit-guard";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const rows = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.userId, user.id))
      .orderBy(desc(agentRuns.createdAt))
      .limit(20);
    return NextResponse.json({
      runs: rows.map((r) => ({
        id: r.id,
        goal: r.goal,
        status: r.status,
        steps: Array.isArray(r.steps) ? r.steps : [],
        result: r.result,
        createdAt: r.createdAt.toISOString(),
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      })),
    });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    // Phase 5.3 — this route is rate limited on both dimensions.
    //
    // Verified finding: an agent run reaches the *same* tool implementations
    // that `/api/tools` and `/api/search` limit — `web_search` (metered
    // Tavily/Brave/SearXNG) and `file_search` (an unindexed `ilike` scan over
    // `documents.rawContent`) — but it does so by calling
    // `ToolExecutor.execute` directly, not over HTTP. A limiter on those two
    // routes therefore cannot see an agent-originated tool call, which made
    // this route a way around both of them.
    //
    // Ordering matches every other protected route: `requireUser` has already
    // resolved the principal, so the bucket is keyed by a server-derived id and
    // an unauthenticated caller can never spend a signed-in user's quota.
    // Placed before the agent executes, so a refused request creates no
    // `agent_runs` row and runs no tool.
    const decision = await checkAgentSessionLimit(user.id, req.headers);
    if (!decision.allowed) {
      // A limiter-store outage is 503, not 429: reporting an outage as a
      // throttle would tell clients to slow down and hide a real incident.
      const storeDown = decision.deniedByStoreFailure;
      return NextResponse.json(
        {
          error: storeDown
            ? "Agent runs are temporarily unavailable. Please retry shortly."
            : "You are starting agent runs too quickly. Please wait a moment and try again.",
          code: storeDown ? "UPSTREAM_UNAVAILABLE" : "RATE_LIMITED",
        },
        { status: storeDown ? 503 : 429, headers: rateLimitHeaders(decision) }
      );
    }

    const body = await req.json().catch(() => null);
    const goal = typeof body?.goal === "string" ? body.goal.trim() : "";
    if (!goal) throw ApiError.badRequest("A goal is required.");
    if (goal.length > 2000) throw ApiError.badRequest("Goal is too long (max 2000 characters).");
    const outcome = await AgentOrchestrator.executeGoal(goal, user.id);
    return NextResponse.json(outcome);
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}
