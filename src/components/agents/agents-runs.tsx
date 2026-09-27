"use client";
import { Bot } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState, SkeletonLines } from "@/components/ui/feedback";
import { formatRelativeTime } from "@/lib/utils";
import type { AgentRunItem } from "@/types";
export function AgentsRuns({ runs, error, onRetry }: {
  runs: AgentRunItem[] | null; error: string | null; onRetry: () => void;
}) {
  return (
    <section aria-label="Agent history">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wider nexa-muted">Recent runs</h2>
      {!runs && !error ? <SkeletonLines count={2} /> : null}
      {error ? <ErrorState tone="warning" title="Run history unavailable" message={error} onRetry={onRetry} /> : null}
      {runs && runs.length === 0 ? (
        <EmptyState icon={<Bot className="size-4" aria-hidden />} title="No agent runs recorded"
          description="No run-history endpoint exists yet. Execute a goal above — its result appears in this session." />) : null}
      {runs && runs.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {runs.map((r) => (
            <li key={r.id} className="rounded-panel border px-3.5 py-3" style={{ borderColor: "var(--nexa-border)" }}>
              <div className="flex items-center gap-2">
                <span className="truncate text-xs font-medium nexa-text">{r.goal}</span>
                <Badge tone={r.status === "completed" ? "success" : r.status === "failed" ? "danger" : "warning"}>{r.status}</Badge>
              </div>
              <p className="mt-1 text-[11px] nexa-muted">{formatRelativeTime(r.createdAt)} · {r.steps.length} steps</p>
            </li>))}
        </ul>) : null}
    </section>
  );
}
