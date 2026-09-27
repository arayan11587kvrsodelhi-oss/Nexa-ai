import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { toolCalls } from "@/db/schema";
import { ToolRegistry } from "@/lib/tools/registry";
import { ToolExecutor } from "@/lib/tools/executor";
import { requireUser } from "@/lib/auth/guard";
import { toErrorResponse, ApiError } from "@/lib/api/errors";
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
