import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { memories } from "@/db/schema";
import { requireUser } from "@/lib/auth/guard";
import { toErrorResponse, ApiError } from "@/lib/api/errors";
import { MemoryService } from "@/lib/memory/memory-service";
import { and, desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const list = await db
      .select()
      .from(memories)
      .where(eq(memories.userId, user.id))
      .orderBy(desc(memories.createdAt));

    return NextResponse.json({
      memories: list.map((m) => ({
        ...m,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const content = String(body.content || "").trim();
    if (!content) {
      throw ApiError.badRequest("Memory content cannot be empty.");
    }

    const memory = await MemoryService.storeMemory(
      user.id,
      content,
      body.category || "preference",
      body.source || "explicit"
    );

    return NextResponse.json({ memory });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}
