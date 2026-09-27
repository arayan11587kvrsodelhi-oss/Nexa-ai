import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { documents } from "@/db/schema";
import { requireUser } from "@/lib/auth/guard";
import { toErrorResponse } from "@/lib/api/errors";
import { RAGRetriever } from "@/lib/rag/retriever";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Query one document. Ownership is verified first: a foreign document id is
 * indistinguishable from a missing one.
 */
export async function POST(
  req: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser(req);
    const { id } = await props.params;
    const body = await req.json().catch(() => ({}));
    const query = String(body.query || "");

    if (!query) {
      return NextResponse.json({ error: "Query is required" }, { status: 400 });
    }

    const owned = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.userId, user.id)))
      .limit(1);
    if (owned.length === 0) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const matches = await RAGRetriever.retrieveRelevantChunks(query, {
      documentIds: [id],
      userId: user.id,
      topK: 5,
      minScore: 0.1,
    });

    return NextResponse.json({
      query,
      documentId: id,
      matches,
      matchCount: matches.length,
    });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}
