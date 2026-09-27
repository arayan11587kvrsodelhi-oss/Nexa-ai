"use client";
import { Badge, StatusDot } from "@/components/ui/badge";
export interface ProviderInfo {
  id: string; name: string; protocol?: string;
  enabled?: boolean; baseUrl?: string | null; note?: string;
}
export function ProviderCards({ providers }: { providers: ProviderInfo[] }) {
  return (
    <ul className="grid gap-2 md:grid-cols-2">
      {providers.map((p) => (
        <li key={p.id} className="rounded-panel border px-3.5 py-3" style={{ borderColor: "var(--nexa-border)" }}>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium nexa-text">{p.name}</span>
            <Badge tone={p.enabled ? "success" : "muted"}>
              <StatusDot tone={p.enabled ? "success" : "neutral"} />
              {p.enabled ? "enabled" : "disabled"}
            </Badge>
          </div>
          {p.baseUrl ? <p className="mt-1 font-mono text-[11px] nexa-muted">{p.baseUrl}</p> : null}
          {p.note ? <p className="mt-1 text-[11px] leading-relaxed nexa-muted">{p.note}</p> : null}
        </li>))}
    </ul>
  );
}
