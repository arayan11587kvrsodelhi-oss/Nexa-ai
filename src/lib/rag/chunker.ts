export interface DocumentChunkData {
  chunkIndex: number;
  content: string;
  tokens: number;
  charStart: number;
  charEnd: number;
}

export class DocumentChunker {
  /**
   * Split text into overlapping semantic chunks
   * @param text Raw text content
   * @param chunkSize Target characters per chunk (default 600)
   * @param overlap Overlap characters between consecutive chunks (default 100)
   */
  public static chunkText(
    text: string,
    chunkSize = 600,
    overlap = 100
  ): DocumentChunkData[] {
    if (!text || text.trim().length === 0) return [];

    const normalized = text.replace(/\r\n/g, "\n");
    const paragraphs = normalized.split(/\n{2,}/);
    const chunks: DocumentChunkData[] = [];

    let currentChunk = "";
    let currentStart = 0;
    let chunkIndex = 0;

    for (const paragraph of paragraphs) {
      const trimmedPara = paragraph.trim();
      if (!trimmedPara) continue;

      if ((currentChunk + "\n\n" + trimmedPara).length <= chunkSize) {
        currentChunk = currentChunk ? currentChunk + "\n\n" + trimmedPara : trimmedPara;
      } else {
        if (currentChunk) {
          chunks.push({
            chunkIndex,
            content: currentChunk,
            tokens: Math.ceil(currentChunk.length / 4),
            charStart: currentStart,
            charEnd: currentStart + currentChunk.length,
          });
          chunkIndex++;
          // Retain overlap from end of currentChunk
          const overlapText = currentChunk.slice(Math.max(0, currentChunk.length - overlap));
          currentStart += currentChunk.length - overlapText.length;
          currentChunk = overlapText + "\n\n" + trimmedPara;
        } else {
          // Paragraph itself is larger than chunkSize, slice into sub-chunks
          let subStart = 0;
          while (subStart < trimmedPara.length) {
            const subEnd = Math.min(subStart + chunkSize, trimmedPara.length);
            const slice = trimmedPara.slice(subStart, subEnd);
            chunks.push({
              chunkIndex,
              content: slice,
              tokens: Math.ceil(slice.length / 4),
              charStart: currentStart + subStart,
              charEnd: currentStart + subEnd,
            });
            chunkIndex++;
            subStart += chunkSize - overlap;
          }
          currentStart += trimmedPara.length;
          currentChunk = "";
        }
      }
    }

    if (currentChunk.trim().length > 0) {
      chunks.push({
        chunkIndex,
        content: currentChunk.trim(),
        tokens: Math.ceil(currentChunk.length / 4),
        charStart: currentStart,
        charEnd: currentStart + currentChunk.length,
      });
    }

    return chunks;
  }

  /**
   * Extract readable text from diverse file formats (txt, md, json, csv, code)
   */
  public static extractText(filename: string, rawContent: string): string {
    const ext = filename.split(".").pop()?.toLowerCase();

    if (ext === "json") {
      try {
        const parsed = JSON.parse(rawContent);
        return JSON.stringify(parsed, null, 2);
      } catch {
        return rawContent;
      }
    }

    if (ext === "csv") {
      // Clean up CSV into structured rows
      const lines = rawContent.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length > 0) {
        return `CSV Dataset (${lines.length} rows):\n` + lines.join("\n");
      }
    }

    return rawContent;
  }
}
