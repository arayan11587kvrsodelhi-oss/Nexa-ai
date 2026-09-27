"use client";
import { useEffect, useState } from "react";
import { FolderKanban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, SkeletonLines } from "@/components/ui/feedback";
import { formatRelativeTime } from "@/lib/utils";
import type { Project } from "@/types";

export function ProjectsPanel() {
  const [items, setItems] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { projects: Project[] };
      setItems(d.projects || []);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Load failed."); }
  };
  useEffect(() => {
    // Runs in a promise continuation: no synchronous state write on mount.
    void (async () => { await Promise.resolve(); await load(); })();
  }, []);
  const create = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setName("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Create failed."); }
    finally { setBusy(false); }
  };
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 py-6">
      <div>
        <h1 className="text-base font-semibold nexa-text">Projects</h1>
        <p className="mt-1 text-xs nexa-muted">Your projects from GET /api/projects. Only rows you own are ever listed.</p>
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <label htmlFor="project-name" className="sr-only">Project name</label>
        <input id="project-name" value={name} onChange={(e) => setName(e.target.value)}
          placeholder="New project name"
          className="flex-1 rounded-control border bg-transparent px-3 py-2 text-sm nexa-text outline-none focus:border-teal-400"
          style={{ borderColor: "var(--nexa-border)" }} />
        <Button type="submit" variant="primary" size="md" loading={busy} disabled={!name.trim()}>Create</Button>
      </form>
      {!items && !error ? <SkeletonLines count={3} /> : null}
      {error ? <ErrorState title="Projects unavailable" message={error} onRetry={() => void load()} /> : null}
      {items && items.length === 0 ? (
        <EmptyState icon={<FolderKanban className="size-4" aria-hidden />} title="No projects yet"
          description="Create your first project above. Nothing here is sample data." />
      ) : null}
      {items && items.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {items.map((p) => (
            <li key={p.id} className="rounded-panel border px-4 py-3" style={{ borderColor: "var(--nexa-border)" }}>
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium nexa-text">{p.name}</span>
                <span className="ml-auto text-[11px] nexa-muted">{p.fileCount ?? 0} files</span>
              </div>
              {p.description ? <p className="mt-1 text-xs nexa-muted">{p.description}</p> : null}
              <p className="mt-1 font-mono text-[10px] nexa-muted">{p.id} · updated {formatRelativeTime(p.updatedAt)}</p>
            </li>))}
        </ul>
      ) : null}
    </div>
  );
}
