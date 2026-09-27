import { db } from "@/db";
import { memories } from "@/db/schema";
import { MemoryItem } from "@/types";
import { and, desc, eq } from "drizzle-orm";

export class MemoryService {
  /**
   * Retrieves a user's active memories to augment their conversation prompts.
   * Memories are strictly per-user: no userId means no memories.
   */
  public static async getActiveMemories(
    userId: string,
    limit = 10
  ): Promise<MemoryItem[]> {
    try {
      const records = await db
        .select()
        .from(memories)
        .where(and(eq(memories.userId, userId), eq(memories.isActive, true)))
        .orderBy(desc(memories.createdAt))
        .limit(limit);

      return records.map((r) => ({
        id: r.id,
        content: r.content,
        category: r.category as "preference" | "fact" | "instruction",
        source: r.source as "explicit" | "inferred",
        isActive: r.isActive,
        createdAt: r.createdAt.toISOString(),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Detects if the user is explicitly requesting the AI to remember something
   */
  public static detectExplicitMemoryRequest(text: string): string | null {
    const patterns = [
      /(?:please\s+)?remember\s+(?:that\s+)?(.+)/i,
      /(?:keep in mind|note down|save to memory)\s+(?:that\s+)?(.+)/i,
      /my\s+(?:preferred|favorite|default)\s+([^.\n]+)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const memoryContent = match[1].trim();
        // Disallow overly long or sensitive items
        if (memoryContent.length > 5 && memoryContent.length < 280) {
          return memoryContent;
        }
      }
    }
    return null;
  }

  /**
   * Store a memory explicitly for a user.
   */
  public static async storeMemory(
    userId: string,
    content: string,
    category: "preference" | "fact" | "instruction" = "preference",
    source: "explicit" | "inferred" = "explicit"
  ): Promise<MemoryItem> {
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const [inserted] = await db
      .insert(memories)
      .values({
        id,
        userId,
        content: content.trim(),
        category,
        source,
        isActive: true,
      })
      .returning();

    return {
      id: inserted.id,
      content: inserted.content,
      category: inserted.category as "preference" | "fact" | "instruction",
      source: inserted.source as "explicit" | "inferred",
      isActive: inserted.isActive,
      createdAt: inserted.createdAt.toISOString(),
    };
  }

  /**
   * Format memories into a concise context block for the system prompt
   */
  public static formatForPrompt(activeMemories: MemoryItem[]): string {
    if (activeMemories.length === 0) return "";
    const lines = activeMemories.map((m) => `- ${m.content}`);
    return `\n\n[USER-APPROVED SAVED MEMORIES / PREFERENCES]:\n${lines.join("\n")}\n`;
  }
}
