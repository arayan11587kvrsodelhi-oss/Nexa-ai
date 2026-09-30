"use client";
import { useEffect, useState } from "react";
import { CheckCircle2, FileUp, Loader2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, SkeletonLines } from "@/components/ui/feedback";
import { formatBytes, formatRelativeTime } from "@/lib/utils";
import { FileQueryBox } from "./file-query-box";
import type { DocumentItem, Project } from "@/types";

/** Mirrors the server's `MAX_FILE_SIZE_BYTES`; the server still enforces it. */
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Phase 7.5 — real upload progress.
 *
 * `fetch` cannot report request-body progress, which is why this previously had
 * no progress at all. `XMLHttpRequest.upload` does, so the upload uses XHR and
 * reports **real** byte counts.
 *
 * The percentage shown is the ratio of bytes the browser has actually handed to
 * the socket, not a timer or an estimate. It is deliberately not extrapolated
 * past 99% while the server is still processing (extraction, chunking,
 * embedding), because that would be a fabricated number: at 100% the work is
 * not done. Above 99% the label switches to an explicit "processing" state.
 */
type UploadPhase =
  | { kind: "idle" }
  | { kind: "uploading"; name: string; sent: number; total: number }
  | { kind: "processing"; name: string }
  | { kind: "done"; name: string }
  | { kind: "error"; name: string; message: string };

function progressPercent(phase: Extract<UploadPhase, { kind: "uploading" }>): number {
  if (phase.total <= 0) return 0;
  return Math.min(100, Math.round((phase.sent / phase.total) * 100));
}

function UploadStatus({ phase }: { phase: UploadPhase }) {
  if (phase.kind === "idle") return null;

  if (phase.kind === "error") {
    return (
      <div role="alert" className="nexa-wash-danger flex items-start gap-2 rounded-panel border px-3 py-2.5"
        style={{ borderColor: "var(--nexa-danger-wash-line)" }}>
        <XCircle className="mt-0.5 size-4 shrink-0" style={{ color: "var(--nexa-danger-strong)" }} aria-hidden />
        <p className="min-w-0 text-xs nexa-text">
          <span className="font-medium">{phase.name}</span>{" "}
          <span className="nexa-muted">— {phase.message}</span>
        </p>
      </div>
    );
  }

  const processing = phase.kind === "processing";
  const percent = phase.kind === "uploading" ? progressPercent(phase) : 100;
  const done = phase.kind === "done";

  return (
    <div
      role="status"
      aria-live="polite"
      className="nexa-raised flex flex-col gap-2 rounded-panel border px-3 py-2.5"
      style={{ borderColor: "var(--nexa-border)" }}
    >
      <div className="flex items-center gap-2">
        {done ? (
          <CheckCircle2 className="size-4 shrink-0" style={{ color: "var(--nexa-success-strong)" }} aria-hidden />
        ) : (
          <Loader2 className="size-4 shrink-0 animate-spin nexa-accent-text" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate text-xs nexa-text">{phase.name}</span>
        <span className="shrink-0 text-[11px] nexa-muted">
          {done
            ? "Indexed"
            : processing
              ? "Processing…"
              : phase.kind === "uploading" && phase.total > 0
                ? `${percent}% · ${formatBytes(phase.sent)} / ${formatBytes(phase.total)}`
                : "Uploading…"}
        </span>
      </div>
      {!done ? (
        <div
          className="nexa-raised h-1 w-full overflow-hidden rounded-full"
          style={{ backgroundColor: "var(--nexa-border)" }}
        >
          <div
            className="h-full rounded-full transition-[width] duration-200"
            style={{
              width: `${percent}%`,
              backgroundColor: processing ? "var(--nexa-warn-strong)" : "var(--nexa-accent)",
            }}
          />
        </div>
      ) : null}
      {processing ? (
        <p className="text-[11px] nexa-muted">
          Upload finished. The server is extracting, chunking and indexing the document.
        </p>
      ) : null}
    </div>
  );
}

export function FilesPanel() {
  const [items, setItems] = useState<DocumentItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [queryId, setQueryId] = useState("");
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>({ kind: "idle" });
  /**
   * Phase 8.4 — project narrowing.
   *
   * The options come from `/api/projects`, which is already user-scoped, so the
   * list can only ever contain the caller's own projects. `""` means "all".
   *
   * The server still applies `userId` unconditionally and treats `projectId` as
   * an additional narrowing condition, so this control cannot widen access even
   * if a value were tampered with.
   */
  const [projectFilter, setProjectFilter] = useState("");
  const [projects, setProjects] = useState<Project[] | null>(null);
  const load = async () => {
    try {
      const qs = projectFilter ? `?projectId=${encodeURIComponent(projectFilter)}` : "";
      const res = await fetch(`/api/files${qs}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { documents: DocumentItem[] };
      setItems(d.documents || []);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Load failed."); }
  };
  // Project options are loaded once; they do not depend on the current filter.
  useEffect(() => {
    void (async () => {
      await Promise.resolve();
      try {
        const res = await fetch("/api/projects", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = (await res.json()) as { projects: Project[] };
        setProjects(d.projects || []);
      } catch {
        // The filter degrades to "All documents" rather than blocking the page.
        setProjects([]);
      }
    })();
  }, []);
  // Re-fetch when the filter changes. Runs in a promise continuation, so there
  // is no synchronous state write during render.
  useEffect(() => {
    void (async () => { await Promise.resolve(); await load(); })();
  }, [projectFilter]);
  const upload = async (file: File) => {
    // Client-side guard only. The server still enforces the 20 MB cap, the
    // one-file-per-request rule, the rate limit and filename sanitization —
    // this only avoids spending a round trip on a file that cannot succeed.
    if (file.size > MAX_BYTES) {
      setUploadPhase({
        kind: "error",
        name: file.name,
        message: `This file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_BYTES)}.`,
      });
      return;
    }

    setBusy(true);
    setUploadPhase({ kind: "uploading", name: file.name, sent: 0, total: file.size });

    const fd = new FormData();
    fd.append("file", file);

    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/files");
        // A real byte-level signal from the browser, not an estimate.
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          setUploadPhase({ kind: "uploading", name: file.name, sent: e.loaded, total: e.total });
        };
        // All bytes are sent; the server now extracts, chunks and embeds.
        xhr.upload.onload = () => {
          setUploadPhase({ kind: "processing", name: file.name });
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setUploadPhase({ kind: "done", name: file.name });
            resolve();
            return;
          }
          // The server's sanitized error layer already returns a safe sentence.
          let message = `Upload failed (HTTP ${xhr.status}).`;
          try {
            const parsed = JSON.parse(xhr.responseText) as { error?: string };
            if (parsed?.error) message = parsed.error;
          } catch {
            /* keep the status-code fallback */
          }
          setUploadPhase({ kind: "error", name: file.name, message });
          reject(new Error(message));
        };
        xhr.onerror = () => {
          const message = "The upload could not reach the server.";
          setUploadPhase({ kind: "error", name: file.name, message });
          reject(new Error(message));
        };
        xhr.send(fd);
      });
      await load();
    } catch {
      /* the phase already carries the user-facing message */
    } finally {
      setBusy(false);
    }
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
      {projects !== null && projects.length > 0 ? (
        <div className="flex flex-col gap-1">
          <label htmlFor="project-filter" className="text-[11px] nexa-muted">
            Project
          </label>
          <select
            id="project-filter"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="nexa-raised w-full max-w-xs rounded-control border px-2.5 py-1.5 text-xs nexa-text outline-none sm:w-auto"
            style={{ borderColor: "var(--nexa-border-strong)" }}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <UploadStatus phase={uploadPhase} />
      {!items && !error ? <SkeletonLines count={3} /> : null}
      {error ? <ErrorState title="Files unavailable" message={error} onRetry={() => void load()} /> : null}
      {items && items.length === 0 ? (
        <EmptyState
          icon={<FileUp className="size-4" aria-hidden />}
          title={projectFilter ? "No documents in this project" : "No documents yet"}
          description={
            projectFilter
              ? "This project has no documents yet, or the filter was changed. Upload a file or choose another project."
              : "Upload a text file above. It is chunked and indexed by the existing /api/files pipeline."
          }
        />
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
