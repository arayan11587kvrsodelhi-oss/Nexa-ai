"use client";
import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, SkeletonLines } from "@/components/ui/feedback";
import { formatBytes, formatRelativeTime } from "@/lib/utils";
import { FileQueryBox } from "./file-query-box";
import type { DocumentItem } from "@/types";

export function FilesPanel() {
  const [items, setItems] = useState<DocumentItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [queryId, setQueryId] = useState("");
  const load = async () => {
    try {
      const res = await fetch("/api/files", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { documents: DocumentItem[] };
      setItems(d.documents || []);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Load failed."); }
  };
  useEffect(() => {
    // Runs in a promise continuation: no synchronous state write on mount.
    void (async () => { await Promise.resolve(); await load(); })();
  }, []);
  const upload = async (file: File) => {
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/files", { method: "POST", body: fd });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error || `Upload failed (HTTP ${res.status}).`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Upload failed."); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Delete failed."); }
  };
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 py-6">
      <div className="flex items-center gap-2">
        <div>
          <h1 className="text-base font-semibold nexa-text">Files</h1>
          <p className="mt-1 text-xs nexa-muted">Documents from GET /api/files. No fake files.</p>
        </div>
        <span className="ml-auto">
          <Button variant="primary" size="sm" loading={busy} onClick={() => document.getElementById("file-pick")?.click()}>Upload</Button>
          <input id="file-pick" type="file" className="hidden" onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = "";
          }} />
        </span>
      </div>
      {!items && !error ? <SkeletonLines count={3} /> : null}
      {error ? <ErrorState title="Files unavailable" message={error} onRetry={() => void load()} /> : null}
      {items && items.length === 0 ? (
        <EmptyState icon={<FileText className="size-4" aria-hidden />} title="No documents yet"
          description="Upload a text file above. It is chunked and indexed by the existing /api/files pipeline." />
      ) : null}
      {items && items.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {items.map((d) => (
            <li key={d.id} className="rounded-panel border px-4 py-3" style={{ borderColor: "var(--nexa-border)" }}>
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium nexa-text">{d.name}</span>
                <Badge tone={d.status === "indexed" ? "success" : "warning"}>{d.status}</Badge>
                <span className="ml-auto text-[11px] nexa-muted">{formatBytes(d.size)} · {d.chunkCount} chunks</span>
              </div>
              <p className="mt-1 font-mono text-[10px] nexa-muted">{d.id} · {formatRelativeTime(d.createdAt)}</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setQueryId(d.id)}>Query this file</Button>
                <Button size="sm" variant="danger" onClick={() => void remove(d.id)}>Delete</Button>
              </div>
            </li>))}
        </ul>
      ) : null}
      <FileQueryBox key={queryId} initialId={queryId} />
    </div>
  );
}
