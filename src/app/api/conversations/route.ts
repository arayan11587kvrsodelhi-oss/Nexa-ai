import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { conversations, messages, projects } from "@/db/schema";
import { requireUser } from "@/lib/auth/guard";
import { toErrorResponse, ApiError } from "@/lib/api/errors";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { LIKE_ESCAPE_CHAR, sanitizeLikePattern } from "@/lib/tools/like-pattern";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const { searchParams } = new URL(req.url);
    const query = searchParams.get("q");
    const includeArchived = searchParams.get("archived") === "true";

    // Ownership is enforced in SQL: only this user's rows are ever read.
    const conditions = [eq(conversations.userId, user.id)];
    // Phase 5.5: the search term is escaped before it becomes a LIKE pattern.
    // Interpolated raw, `?q=%` matched every conversation the user owns, and a
    // guaranteed-match scan never short-circuits. The result set is unchanged
    // for an ordinary term; only wildcard semantics are removed.
    //
    // `ESCAPE` is stated explicitly rather than relying on PostgreSQL's implicit
    // backslash default. Drizzle's `ilike()` takes no escape argument, so this
    // is composed with `sql` — the term is still bound as a parameter, never
    // concatenated into the statement.
    const term = query ? sanitizeLikePattern(query) : "";
    if (term) {
      conditions.push(sql`${conversations.title} ILIKE ${`%${term}%`} ESCAPE ${LIKE_ESCAPE_CHAR}`);
    }
    if (!includeArchived) conditions.push(eq(conversations.isArchived, false));

    const list = await db
      .select()
      .from(conversations)
      .where(and(...conditions))
      .orderBy(desc(conversations.isPinned), desc(conversations.updatedAt))
      .limit(50);

    // Get message count for each conversation
    const result = await Promise.all(
      list.map(async (conv) => {
        const msgs = await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.conversationId, conv.id));
        return {
          ...conv,
          createdAt: conv.createdAt.toISOString(),
          updatedAt: conv.updatedAt.toISOString(),
          messageCount: msgs.length,
        };
      })
    );

    return NextResponse.json({ conversations: result });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const title = body.title || "New Workspace Session";
    const model = body.model || "llama3.2:3b";
    const profile = body.profile || "BALANCED";

    // A conversation may only reference a project owned by the same user.
    let projectId: string | null = null;
    if (typeof body.projectId === "string" && body.projectId) {
      const owned = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, body.projectId), eq(projects.userId, user.id)))
        .limit(1);
      if (owned.length === 0) throw ApiError.badRequest("Unknown project.");
      projectId = body.projectId;
    }

    const [newConv] = await db
      .insert(conversations)
      .values({
        id,
        userId: user.id,
        title,
        model,
        profile,
        systemPrompt: body.systemPrompt || null,
        projectId,
      })
      .returning();

    return NextResponse.json({
      conversation: {
        ...newConv,
        createdAt: newConv.createdAt.toISOString(),
        updatedAt: newConv.updatedAt.toISOString(),
        messageCount: 0,
      },
    });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}
