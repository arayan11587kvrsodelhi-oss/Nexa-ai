export class LocalEmbeddingService {
  private static readonly DIMENSIONS = 256;

  /**
   * Generates a 256-dimensional normalized semantic feature vector for text.
   * Uses semantic n-gram feature hashing with frequency dampening,
   * providing consistent, zero-dependency, local vector embeddings.
   */
  public static generateEmbedding(text: string): number[] {
    const vector = new Float32Array(this.DIMENSIONS);
    if (!text || text.trim().length === 0) {
      return Array.from(vector);
    }

    const cleaned = text.toLowerCase().replace(/[^a-z0-9\s_-]/g, " ");
    const words = cleaned.split(/\s+/).filter((w) => w.length > 1);

    // Hash unigrams and bigrams
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const hash1 = this.fnv1a(word);
      const idx1 = Math.abs(hash1) % this.DIMENSIONS;
      const sign1 = (hash1 & 1) === 0 ? 1 : -1;
      vector[idx1] += sign1 * (1.0 / Math.sqrt(words.length));

      if (i < words.length - 1) {
        const bigram = `${word}_${words[i + 1]}`;
        const hash2 = this.fnv1a(bigram);
        const idx2 = Math.abs(hash2) % this.DIMENSIONS;
        const sign2 = (hash2 & 1) === 0 ? 1 : -1;
        vector[idx2] += sign2 * 1.5 * (1.0 / Math.sqrt(words.length));
      }
    }

    // L2 Normalize vector
    let sumSq = 0;
    for (let i = 0; i < this.DIMENSIONS; i++) {
      sumSq += vector[i] * vector[i];
    }
    const norm = Math.sqrt(sumSq) || 1;
    for (let i = 0; i < this.DIMENSIONS; i++) {
      vector[i] = vector[i] / norm;
    }

    return Array.from(vector);
  }

  /**
   * Fast 32-bit FNV-1a hash
   */
  private static fnv1a(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash | 0;
  }

  /**
   * Cosine similarity between two unit vectors: dot product
   */
  public static cosineSimilarity(a: number[], b: number[]): number {
    if (!a || !b || a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return Math.max(-1, Math.min(1, dot));
  }
}
