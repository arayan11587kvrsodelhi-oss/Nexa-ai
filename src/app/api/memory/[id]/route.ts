import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { memories } from "@/db/schema";
import { requireUser } from "@/lib/auth/guard";
import { toErrorResponse } from "@/lib/api/errors";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser(req);
    const { id } = await props.params;
    const body = await req.json().catch(() => ({}));

    const [updated] = await db
      .update(memories)
      .set({
        isActive: typeof body.isActive === "boolean" ? body.isActive : true,
      })
      .where(and(eq(memories.id, id), eq(memories.userId, user.id)))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Memory not found" }, { status: 404 });
    }
    return NextResponse.json({
      memory: { ...updated, createdAt: updated.createdAt.toISOString() },
    });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}

export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser(req);
    const { id } = await props.params;
    const deleted = await db
      .delete(memories)
      .where(and(eq(memories.id, id), eq(memories.userId, user.id)))
      .returning({ id: memories.id });
    if (deleted.length === 0) {
      return NextResponse.json({ error: "Memory not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, deletedId: id });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}
