"use client";
import { useEffect, useState } from "react";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState, SkeletonLines } from "@/components/ui/feedback";
import { ProviderCards, type ProviderInfo } from "./provider-cards";
import { ModelCatalog, type DiscoveredModel } from "./model-catalog";

interface FullPayload {
  activeConfig?: { provider?: string; modelName?: string; baseUrl?: string; isDemo?: boolean; source?: string };
  databaseReachable?: boolean;
  reachability?: { ok?: boolean; message?: string; latencyMs?: number };
  providers?: ProviderInfo[];
  discoveredModels?: DiscoveredModel[];
  models?: Array<{ id: string; name: string; provider: string; description?: string }>;
}

export function ModelsPanel() {
  const [data, setData] = useState<FullPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const load = async () => {
    try {
      const res = await fetch("/api/models", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json() as FullPayload);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Load failed."); }
  };
  useEffect(() => {
    // Runs in a promise continuation: no synchronous state write on mount.
    void (async () => { await Promise.resolve(); await load(); })();
  }, []);
  const test = async () => {
    setTesting(true); setTestMsg(null);
    try {
      const res = await fetch("/api/models/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: data?.activeConfig?.provider || "freellmapi" }),
      });
      const d = (await res.json()) as { ok?: boolean; message?: string; latencyMs?: number };
      setTestMsg(`${d.ok ? "Reachable" : "Unreachable"} — ${d.message || "no message"}${d.latencyMs ? ` (${d.latencyMs} ms)` : ""}`);
      void load();
      window.dispatchEvent(new Event("nexa:engine-changed"));
    } catch (e) { setTestMsg(e instanceof Error ? e.message : "Test failed."); }
    finally { setTesting(false); }
  };
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 py-6">
      <div className="flex items-center gap-2">
        <div>
          <h1 className="text-base font-semibold nexa-text">Models</h1>
          <p className="mt-1 text-xs nexa-muted">Live readout from GET /api/models. No counts are hard-coded; no keys are shown.</p>
        </div>
        <span className="ml-auto flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => void load()}>Refresh</Button>
          <Button size="sm" variant="primary" loading={testing} onClick={() => void test()}>Test connection</Button>
        </span>
      </div>
      {!data && !error ? <SkeletonLines count={4} /> : null}
      {error ? <ErrorState title="Models unavailable" message={error} onRetry={() => void load()} /> : null}
      {testMsg ? <p className="text-xs nexa-muted" role="status">{testMsg}</p> : null}
      {data ? (
        <>
          <div className="nexa-overlay rounded-panel border px-4 py-3" style={{ borderColor: "var(--nexa-border)" }}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium nexa-text">Active configuration</span>
              <Badge tone={data.reachability?.ok ? "success" : "warning"}>
                <StatusDot tone={data.reachability?.ok ? "success" : "warning"} />
                {data.reachability?.ok ? "reachable" : "unreachable"}
              </Badge>
              {data.activeConfig?.isDemo ? <Badge tone="warning">demo</Badge> : null}
              {data.databaseReachable === false ? <Badge tone="danger">db down</Badge> : null}
            </div>
            <dl className="mt-2 grid gap-1 font-mono text-[11px] nexa-muted">
              <div className="flex gap-2"><dt>provider:</dt><dd className="nexa-text">{data.activeConfig?.provider || "—"}</dd></div>
              <div className="flex gap-2"><dt>model:</dt><dd className="nexa-text">{data.activeConfig?.modelName || "—"}</dd></div>
              <div className="flex gap-2"><dt>endpoint:</dt><dd>{data.activeConfig?.baseUrl || "—"}</dd></div>
              <div className="flex gap-2"><dt>source:</dt><dd>{data.activeConfig?.source || "—"}</dd></div>
            </dl>
            <p className="mt-2 text-[11px] nexa-muted">{data.reachability?.message || "No provider message."}</p>
          </div>
          <ProviderCards providers={data.providers || []} />
          <ModelCatalog models={data.models || []} discovered={data.discoveredModels || []} />
        </>
      ) : null}
    </div>
  );
}
