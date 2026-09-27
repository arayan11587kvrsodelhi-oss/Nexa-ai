import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { agentRuns } from "@/db/schema";
import { AgentOrchestrator } from "@/lib/agents/orchestrator";
import { requireUser } from "@/lib/auth/guard";
import { ApiError, toErrorResponse } from "@/lib/api/errors";
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
