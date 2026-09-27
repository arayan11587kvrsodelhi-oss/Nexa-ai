import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { documentChunks, documents } from "@/db/schema";
import { requireUser } from "@/lib/auth/guard";
import { toErrorResponse } from "@/lib/api/errors";
import { and, asc, eq } from "drizzle-orm";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser(req);
    const { id } = await props.params;

    const docs = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.userId, user.id)))
      .limit(1);
    if (docs.length === 0) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const chunks = await db
      .select({
        id: documentChunks.id,
        chunkIndex: documentChunks.chunkIndex,
        content: documentChunks.content,
        metadata: documentChunks.metadata,
      })
      .from(documentChunks)
      .where(eq(documentChunks.documentId, id))
      .orderBy(asc(documentChunks.chunkIndex))
      .limit(60);

    return NextResponse.json({
      document: {
        ...docs[0],
        createdAt: docs[0].createdAt.toISOString(),
      },
      chunks,
    });
  } catch (err: unknown) {
    // Sanitized: raw driver messages must never reach the client.
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
      .delete(documents)
      .where(and(eq(documents.id, id), eq(documents.userId, user.id)))
      .returning({ id: documents.id });
    if (deleted.length === 0) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, deletedId: id });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}
