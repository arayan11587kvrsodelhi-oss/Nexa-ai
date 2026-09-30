import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { documentChunks, documents, projects } from "@/db/schema";
import { requireUser } from "@/lib/auth/guard";
import { toErrorResponse, ApiError } from "@/lib/api/errors";
import { DocumentChunker } from "@/lib/rag/chunker";
import { LocalEmbeddingService } from "@/lib/rag/embeddings";
import { SecurityGuard } from "@/lib/security/sanitize";
import { AuditLogger } from "@/lib/security/audit";
import { checkFileUploadLimit, rateLimitHeaders } from "@/lib/gateway/rate-limit-guard";
import { and, desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);

    // Phase 8.4 — optional project narrowing.
    //
    // The `userId` condition is authoritative and is always applied. A
    // `projectId` supplied by the client is only ever an *additional* narrowing
    // on top of it — it is never a way to reach anything.
    //
    // That matters: if a caller forges another tenant's project id, the query
    // still requires `documents.userId = <their own id>`, so the result is
    // simply empty. No extra ownership query is needed, and no information
    // about the foreign project leaks — the response cannot distinguish
    // "project does not exist" from "project is not yours", because both are
    // the same empty list.
    const projectId = req.nextUrl.searchParams.get("projectId")?.trim() || null;

    const filters = [eq(documents.userId, user.id)];
    if (projectId) filters.push(eq(documents.projectId, projectId));

    const docs = await db
      .select({
        id: documents.id,
        name: documents.name,
        mimeType: documents.mimeType,
        size: documents.size,
        characterCount: documents.characterCount,
        chunkCount: documents.chunkCount,
        status: documents.status,
        projectId: documents.projectId,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(and(...filters))
      .orderBy(desc(documents.createdAt))
      .limit(50);

    return NextResponse.json({
      documents: docs.map((d) => ({
        ...d,
        createdAt: d.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);

    // Phase 5.4 — this route is rate limited on both dimensions.
    //
    // Verified: it previously had no application-level limit, while every
    // accepted upload reads up to 20 MB, inserts the whole raw text, chunks
    // it, and then runs one `generateEmbedding` per chunk before batched
    // inserts. A loop here is both a CPU/IO amplifier and unbounded storage
    // growth.
    //
    // Placed before `req.formData()` / `req.json()` so a refused request does
    // not even buffer the body, and before the ownership lookup and every
    // write. `requireUser` has already resolved the principal, so the bucket
    // is keyed by a server-derived id and an unauthenticated caller can never
    // spend a signed-in user's quota.
    const decision = await checkFileUploadLimit(user.id, req.headers);
    if (!decision.allowed) {
      // A limiter-store outage is 503, not 429: reporting an outage as a
      // throttle would tell clients to slow down and hide a real incident.
      const storeDown = decision.deniedByStoreFailure;
      return NextResponse.json(
        {
          error: storeDown
            ? "Uploads are temporarily unavailable. Please retry shortly."
            : "You are uploading too quickly. Please wait a moment and try again.",
          code: storeDown ? "DATABASE_UNAVAILABLE" : "RATE_LIMITED",
        },
        { status: storeDown ? 503 : 429, headers: rateLimitHeaders(decision) }
      );
    }

    let name = "";
    let rawContent = "";
    let mimeType = "text/plain";
    let projectIdArg: string | null = null;
    let size = 0;

    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("file") as File | null;
      if (!file) {
        return NextResponse.json({ error: "No file uploaded in form data" }, { status: 400 });
      }
      name = file.name;
      size = file.size;
      mimeType = file.type || "text/plain";
      rawContent = await file.text();
      const pId = formData.get("projectId");
      if (typeof pId === "string") projectIdArg = pId;
    } else {
      const body = await req.json();
      name = body.name || "document.txt";
      rawContent = body.content || "";
      size = body.size || rawContent.length;
      mimeType = body.mimeType || "text/plain";
      projectIdArg = body.projectId || null;
    }

    // Security validation
    const sanitizedName = SecurityGuard.sanitizeFilename(name);
    const validation = SecurityGuard.validateUpload(sanitizedName, size);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // Clean & extract text
    const cleanContent = DocumentChunker.extractText(sanitizedName, rawContent);
    const docId = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    // A document may only be attached to a project owned by the same user.
    let projectId: string | null = null;
    if (typeof projectIdArg === "string" && projectIdArg) {
      const owned = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectIdArg), eq(projects.userId, user.id)))
        .limit(1);
      if (owned.length === 0) throw ApiError.badRequest("Unknown project.");
      projectId = projectIdArg;
    }

    // Create document record
    const [newDoc] = await db
      .insert(documents)
      .values({
        id: docId,
        userId: user.id,
        name: sanitizedName,
        mimeType,
        size,
        characterCount: cleanContent.length,
        chunkCount: 0,
        status: "pending",
        projectId,
        rawContent: cleanContent,
      })
      .returning();

    // Chunk text
    const rawChunks = DocumentChunker.chunkText(cleanContent, 650, 120);

    // Generate embeddings and store chunks
    if (rawChunks.length > 0) {
      const chunkInserts = rawChunks.map((chunk) => {
        const embedding = LocalEmbeddingService.generateEmbedding(chunk.content);
        return {
          id: `chk_${Date.now()}_${chunk.chunkIndex}_${Math.random().toString(36).slice(2, 5)}`,
          documentId: docId,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          embedding,
          metadata: {
            documentName: sanitizedName,
            tokens: chunk.tokens,
            charStart: chunk.charStart,
            charEnd: chunk.charEnd,
          },
        };
      });

      // Insert chunks in batches of 25
      for (let i = 0; i < chunkInserts.length; i += 25) {
        const batch = chunkInserts.slice(i, i + 25);
        await db.insert(documentChunks).values(batch);
      }

      // Update document chunk count and indexed status
      await db
        .update(documents)
        .set({
          chunkCount: rawChunks.length,
          status: "indexed",
        })
        .where(eq(documents.id, docId));
    } else {
      await db
        .update(documents)
        .set({ status: "indexed", chunkCount: 0 })
        .where(eq(documents.id, docId));
    }

    await AuditLogger.log(
      "file_indexed",
      {
        documentId: docId,
        name: sanitizedName,
        chunkCount: rawChunks.length,
        size,
      },
      undefined,
      "success",
      user.id
    );

    return NextResponse.json({
      document: {
        id: newDoc.id,
        name: newDoc.name,
        size: newDoc.size,
        characterCount: cleanContent.length,
        chunkCount: rawChunks.length,
        status: "indexed",
        createdAt: newDoc.createdAt.toISOString(),
      },
    });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}
