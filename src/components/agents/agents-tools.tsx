"use client";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState, SkeletonLines } from "@/components/ui/feedback";
import type { ToolDefinition } from "@/types";
export function AgentsTools({ tools, error, onRetry }: {
  tools: ToolDefinition[] | null; error: string | null; onRetry: () => void;
}) {
  return (
    <section aria-label="Available tools">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wider nexa-muted">Tools the orchestrator can call</h2>
      {!tools && !error ? <SkeletonLines count={3} /> : null}
      {error ? <ErrorState title="Tools unavailable" message={error} onRetry={onRetry} /> : null}
      {tools && tools.length === 0 ? <EmptyState title="No tools registered" description="The tool registry returned an empty list." /> : null}
      {tools && tools.length > 0 ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {tools.map((t) => (
            <li key={t.name} className="rounded-panel border px-3.5 py-3" style={{ borderColor: "var(--nexa-border)" }}>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium nexa-text">{t.name}</span>
                <Badge tone={t.enabled ? "accent" : "muted"}>{t.enabled ? "enabled" : "disabled"}</Badge>
                <Badge tone="muted">{t.riskLevel}</Badge>
              </div>
              <p className="mt-1 text-[11px] nexa-muted">{t.description}</p>
            </li>))}
        </ul>) : null}
    </section>
  );
}
