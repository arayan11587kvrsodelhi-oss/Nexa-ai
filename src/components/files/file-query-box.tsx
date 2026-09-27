"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
export function FileQueryBox({ initialId = "" }: { initialId?: string }) {
  const [docId, setDocId] = useState(initialId);
  const [q, setQ] = useState("");
  const [out, setOut] = useState<string | null>(null);
  const ask = async () => {
    const id = docId.trim();
    const query = q.trim();
    if (!id || !query) return;
    setOut("Searching…");
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(id)}/query`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const d = (await res.json()) as { matches?: Array<{ content: string; score?: number }>; error?: string };
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      const ms = d.matches || [];
      setOut(ms.length === 0 ? "No matching chunks." : ms.map((m, i) => `[${i + 1}] score ${m.score ?? "?"} — ${m.content.slice(0, 400)}`).join("\n\n"));
    } catch (e) { setOut(e instanceof Error ? e.message : "Query failed."); }
  };
  return (
    <section aria-label="Query a document" className="nexa-overlay rounded-panel border p-4" style={{ borderColor: "var(--nexa-border)" }}>
      <h2 className="text-xs font-medium nexa-text">Query a document</h2>
      <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
        <input value={docId} onChange={(e) => setDocId(e.target.value)} placeholder="document id" aria-label="Document id"
          className="rounded-control border bg-transparent px-3 py-2 font-mono text-xs nexa-text outline-none focus:border-teal-400"
          style={{ borderColor: "var(--nexa-border)" }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="query text" aria-label="Query text"
          className="rounded-control border bg-transparent px-3 py-2 text-xs nexa-text outline-none focus:border-teal-400"
          style={{ borderColor: "var(--nexa-border)" }} />
        <Button size="sm" variant="secondary" onClick={() => void ask()}>Ask</Button>
      </div>
      {out ? <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap text-[11px] nexa-muted">{out}</pre> : null}
    </section>
  );
}
