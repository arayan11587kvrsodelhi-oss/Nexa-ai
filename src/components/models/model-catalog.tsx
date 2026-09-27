"use client";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/feedback";
export interface DiscoveredModel { id: string; name: string; contextWindow: number | null }
export function ModelCatalog({ models, discovered }: {
  models: Array<{ id: string; name: string; provider: string; description?: string }>;
  discovered: DiscoveredModel[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Discovered models">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wider nexa-muted">Reported by the active provider</h2>
        {discovered.length === 0 ? (
          <EmptyState title="No models reported" description="The active provider did not return a model list from its discovery endpoint. The configured model name above is still what chat will request." />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {discovered.map((m) => (
              <li key={m.id} className="rounded-panel border px-3.5 py-2.5" style={{ borderColor: "var(--nexa-border)" }}>
                <p className="font-mono text-xs nexa-text">{m.id}</p>
                <p className="mt-0.5 text-[11px] nexa-muted">{m.name}{m.contextWindow ? ` · ${m.contextWindow} ctx` : ""}</p>
              </li>))}
          </ul>)}
      </section>
      <section aria-label="Curated catalogue">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wider nexa-muted">Curated local catalogue</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {models.map((m) => (
            <li key={m.id} className="rounded-panel border px-3.5 py-2.5" style={{ borderColor: "var(--nexa-border)" }}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs nexa-text">{m.id}</span>
                <Badge tone="muted">{m.provider}</Badge>
              </div>
              <p className="mt-0.5 text-[11px] nexa-muted">{m.description || m.name}</p>
            </li>))}
        </ul>
      </section>
    </div>
  );
}
