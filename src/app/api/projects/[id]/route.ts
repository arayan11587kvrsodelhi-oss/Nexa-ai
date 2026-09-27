import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { conversations, documents, projects } from "@/db/schema";
import { requireUser } from "@/lib/auth/guard";
import { toErrorResponse } from "@/lib/api/errors";
import { and, desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser(req);
    const { id } = await props.params;

    const projs = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, user.id)))
      .limit(1);
    if (projs.length === 0) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const project = projs[0];

    const projectDocs = await db
      .select({
        id: documents.id,
        name: documents.name,
        size: documents.size,
        characterCount: documents.characterCount,
        chunkCount: documents.chunkCount,
        status: documents.status,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(and(eq(documents.projectId, id), eq(documents.userId, user.id)))
      .orderBy(desc(documents.createdAt));

    const projectConvs = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        model: conversations.model,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(and(eq(conversations.projectId, id), eq(conversations.userId, user.id)))
      .orderBy(desc(conversations.updatedAt));

    return NextResponse.json({
      project: {
        ...project,
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
      },
      documents: projectDocs.map((d) => ({
        ...d,
        createdAt: d.createdAt.toISOString(),
      })),
              conversations: projectConvs.map((c) => ({
                ...c,
                updatedAt: c.updatedAt.toISOString(),
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
    const body = await req.json();

    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };
    if (typeof body.name === "string") updateData.name = body.name.trim();
    if (typeof body.description !== "undefined") updateData.description = body.description;
    if (typeof body.instructions !== "undefined") updateData.instructions = body.instructions;
    if (typeof body.modelPreference === "string") updateData.modelPreference = body.modelPreference;

    const [updated] = await db
      .update(projects)
      .set(updateData)
      .where(and(eq(projects.id, id), eq(projects.userId, user.id)))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    return NextResponse.json({ project: updated });
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
      .delete(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, user.id)))
      .returning({ id: projects.id });
    if (deleted.length === 0) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, deletedId: id });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}
