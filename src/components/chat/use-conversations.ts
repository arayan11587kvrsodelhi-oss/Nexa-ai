"use client";
import { useCallback, useState } from "react";
import type { Conversation } from "@/types";

/** Loads the signed-in user's conversations from GET /api/conversations. */
export function useConversations() {
  const [items, setItems] = useState<Conversation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { conversations: Conversation[] };
      setItems(data.conversations || []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed.");
    }
  }, []);
  return { items, error, refresh };
}
