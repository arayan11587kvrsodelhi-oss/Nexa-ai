"use client";
import { useEffect, useState } from "react";
import { Brain } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, SkeletonLines } from "@/components/ui/feedback";
import { formatRelativeTime } from "@/lib/utils";
import type { MemoryItem } from "@/types";

export function MemoryPanel() {
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      const res = await fetch("/api/memory", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { memories: MemoryItem[] };
      setItems(d.memories || []);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Load failed."); }
  };
  useEffect(() => {
    // Runs in a promise continuation: no synchronous state write on mount.
    void (async () => { await Promise.resolve(); await load(); })();
  }, []);
  const save = async () => {
    const c = content.trim();
    if (!c || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/memory", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: c, category: "preference", source: "explicit" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setContent("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed."); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Delete failed."); }
  };
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 py-6">
      <div>
        <h1 className="text-base font-semibold nexa-text">Memory</h1>
        <p className="mt-1 text-xs nexa-muted">Real stored memories from GET /api/memory. Honest empty state when none exist.</p>
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label htmlFor="memory-content" className="sr-only">New memory</label>
        <input id="memory-content" value={content} onChange={(e) => setContent(e.target.value)}
          placeholder="Remember: I prefer concise answers"
          className="flex-1 rounded-control border bg-transparent px-3 py-2 text-sm nexa-text outline-none focus:border-teal-400"
          style={{ borderColor: "var(--nexa-border)" }} />
        <Button type="submit" variant="primary" size="md" loading={busy} disabled={!content.trim()}>Save</Button>
      </form>
      {!items && !error ? <SkeletonLines count={3} /> : null}
      {error ? <ErrorState title="Memory unavailable" message={error} onRetry={() => void load()} /> : null}
      {items && items.length === 0 ? (
        <EmptyState icon={<Brain className="size-4" aria-hidden />} title="No memories stored"
          description="Nothing has been saved yet. Memories you save here are injected into future chat prompts." />
      ) : null}
      {items && items.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {items.map((m) => (
            <li key={m.id} className="rounded-panel border px-4 py-3" style={{ borderColor: "var(--nexa-border)" }}>
              <div className="flex items-center gap-2">
                <Badge tone={m.isActive ? "accent" : "muted"}>{m.isActive ? "active" : "inactive"}</Badge>
                <Badge tone="muted">{m.category}</Badge>
                <Badge tone="muted">{m.source}</Badge>
                <span className="ml-auto text-[11px] nexa-muted">{formatRelativeTime(m.createdAt)}</span>
              </div>
              <p className="mt-1.5 text-sm nexa-text">{m.content}</p>
              <div className="mt-2">
                <Button size="sm" variant="danger" onClick={() => void remove(m.id)}>Forget</Button>
              </div>
            </li>))}
        </ul>
      ) : null}
    </div>
  );
}
