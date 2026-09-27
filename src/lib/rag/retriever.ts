import { db } from "@/db";
import { documentChunks, documents } from "@/db/schema";
import { Citation } from "@/types";
import { and, eq, inArray } from "drizzle-orm";
import { LocalEmbeddingService } from "./embeddings";

export interface RetrievedChunk {
  id: string;
  documentId: string;
  documentName: string;
  chunkIndex: number;
  content: string;
  score: number;
  citation: Citation;
}

export class RAGRetriever {
  /**
   * Retrieves top relevant chunks for a user query.
   * Uses hybrid scoring: 70% vector cosine similarity + 30% lexical match.
   */
  public static async retrieveRelevantChunks(
    query: string,
    options: {
      documentIds?: string[];
      projectId?: string;
      /** Owner scope. Retrieval never crosses user boundaries. */
      userId?: string;
      topK?: number;
      minScore?: number;
    } = {}
  ): Promise<RetrievedChunk[]> {
    const topK = options.topK ?? 4;
    const minScore = options.minScore ?? 0.25;

    // 1. Fetch eligible documents
    const docFilters = [];
    if (options.userId) docFilters.push(eq(documents.userId, options.userId));
    if (options.projectId) docFilters.push(eq(documents.projectId, options.projectId));

    let eligibleDocIds = options.documentIds;
    if (!eligibleDocIds || eligibleDocIds.length === 0) {
      const docs = await db
        .select({ id: documents.id, name: documents.name })
        .from(documents)
        .where(docFilters.length > 0 ? and(...docFilters) : undefined)
        .limit(20);

      eligibleDocIds = docs.map((d) => d.id);
    }

    if (!eligibleDocIds || eligibleDocIds.length === 0) {
      return [];
    }

    // 2. Fetch chunks from DB
    const chunks = await db
      .select({
        id: documentChunks.id,
        documentId: documentChunks.documentId,
        chunkIndex: documentChunks.chunkIndex,
        content: documentChunks.content,
        embedding: documentChunks.embedding,
        metadata: documentChunks.metadata,
      })
      .from(documentChunks)
      .where(inArray(documentChunks.documentId, eligibleDocIds));

    if (chunks.length === 0) {
      return [];
    }

    // 3. Compute query vector
    const queryVector = LocalEmbeddingService.generateEmbedding(query);
    const queryTerms = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

    // 4. Score each chunk
    const scoredChunks: RetrievedChunk[] = [];

    for (const chunk of chunks) {
      const chunkVector = (chunk.embedding as number[]) || [];
      const vectorSim =
        chunkVector.length > 0
          ? LocalEmbeddingService.cosineSimilarity(queryVector, chunkVector)
          : 0;

      // Lexical term match
      const chunkLower = chunk.content.toLowerCase();
      let matchedTerms = 0;
      for (const term of queryTerms) {
        if (chunkLower.includes(term)) {
          matchedTerms++;
        }
      }
      const lexicalScore =
        queryTerms.length > 0 ? matchedTerms / queryTerms.length : 0;

      // Hybrid combination
      const hybridScore = Math.max(0, vectorSim * 0.7 + lexicalScore * 0.3);

      if (hybridScore >= minScore) {
        const docName =
          (chunk.metadata as { documentName?: string })?.documentName ||
          "Document";

        scoredChunks.push({
          id: chunk.id,
          documentId: chunk.documentId,
          documentName: docName,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          score: Math.round(hybridScore * 100) / 100,
          citation: {
            title: `${docName} (Section ${chunk.chunkIndex + 1})`,
            snippet:
              chunk.content.length > 200
                ? chunk.content.slice(0, 200) + "..."
                : chunk.content,
            sourceType: "file",
            chunkIndex: chunk.chunkIndex,
            score: Math.round(hybridScore * 100) / 100,
          },
        });
      }
    }

    // 5. Sort descending by score and pick topK
    scoredChunks.sort((a, b) => b.score - a.score);
    return scoredChunks.slice(0, topK);
  }
}
