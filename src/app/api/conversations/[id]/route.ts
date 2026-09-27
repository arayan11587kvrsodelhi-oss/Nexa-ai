import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { conversations, messages } from "@/db/schema";
import { requireUser } from "@/lib/auth/guard";
import { toErrorResponse, ApiError } from "@/lib/api/errors";
import { and, asc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Ownership note: every WHERE clause pairs `id` with `userId`. A foreign id is
 * indistinguishable from a missing one (404) so resource existence under
 * another owner is never revealed.
 */
export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser(req);
    const { id } = await props.params;

    const convs = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))
      .limit(1);

    if (convs.length === 0) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    const conv = convs[0];
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.createdAt));

    return NextResponse.json({
      conversation: {
        ...conv,
        createdAt: conv.createdAt.toISOString(),
        updatedAt: conv.updatedAt.toISOString(),
      },
      messages: msgs.map((m) => ({
        ...m,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser(req);
    const { id } = await props.params;
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw ApiError.badRequest("A JSON body is required.");
    }

    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (typeof body.title === "string") updateData.title = body.title.trim();
    if (typeof body.isArchived === "boolean") updateData.isArchived = body.isArchived;
    if (typeof body.isPinned === "boolean") updateData.isPinned = body.isPinned;
    if (typeof body.profile === "string") updateData.profile = body.profile;
    if (typeof body.model === "string") updateData.model = body.model;
    if (typeof body.systemPrompt !== "undefined") updateData.systemPrompt = body.systemPrompt;

    const [updated] = await db
      .update(conversations)
      .set(updateData)
      .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    return NextResponse.json({
      conversation: {
        ...updated,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
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
          .delete(conversations)
          .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))
          .returning({ id: conversations.id });
        if (deleted.length === 0) {
          return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
        }
        return NextResponse.json({ ok: true, deletedId: id });
      } catch (err) {
        return toErrorResponse(err, { request: req });
      }
    }
