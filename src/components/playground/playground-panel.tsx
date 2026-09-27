"use client";
import { useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, SkeletonLines } from "@/components/ui/feedback";
import { PlaygroundForm } from "./playground-form";

export function PlaygroundPanel() {
  const [active, setActive] = useState<{ provider?: string; modelName?: string } | null>(null);
  const [ok, setOk] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const load = async () => {
    try {
      const res = await fetch("/api/models", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as {
        activeConfig?: { provider?: string; modelName?: string };
        reachability?: { ok?: boolean; message?: string };
      };
      setActive(d.activeConfig || null);
      setOk(d.reachability?.ok ?? null);
      setMsg(d.reachability?.message || null);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Load failed."); }
  };
  useEffect(() => {
    // Runs in a promise continuation: no synchronous state write on mount.
    void (async () => { await Promise.resolve(); await load(); })();
  }, []);
  const test = async () => {
    setTesting(true);
    try {
      const res = await fetch("/api/models/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: active?.provider || "freellmapi" }),
      });
      const d = (await res.json()) as { ok?: boolean; message?: string };
      setOk(d.ok ?? null);
      setMsg(d.message || null);
      window.dispatchEvent(new Event("nexa:engine-changed"));
    } catch (e) { setMsg(e instanceof Error ? e.message : "Test failed."); }
    finally { setTesting(false); }
  };
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 py-6">
      <div>
        <h1 className="text-base font-semibold nexa-text">Playground</h1>
        <p className="mt-1 text-xs nexa-muted">Model testing: connection test plus one real streamed reply. Nothing simulated.</p>
      </div>
      {!active && !error ? <SkeletonLines count={3} /> : null}
      {error ? <ErrorState title="Playground unavailable" message={error} onRetry={() => void load()} /> : null}
      {active ? (
        <div className="nexa-overlay rounded-panel border px-4 py-3" style={{ borderColor: "var(--nexa-border)" }}>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs nexa-text">{active.provider} · {active.modelName}</span>
            {ok !== null ? (
              <Badge tone={ok ? "success" : "warning"}><StatusDot tone={ok ? "success" : "warning"} />{ok ? "reachable" : "unreachable"}</Badge>
            ) : null}
            <span className="ml-auto"><Button size="sm" variant="secondary" loading={testing} onClick={() => void test()}>Test connection</Button></span>
          </div>
          {msg ? <p className="mt-1 text-[11px] nexa-muted">{msg}</p> : null}
        </div>
      ) : null}
      <PlaygroundForm />
      <EmptyState icon={<FlaskConical className="size-4" aria-hidden />} title="How it works"
        description="The form above sends one prompt through POST /api/chat and streams the provider reply verbatim." />
    </div>
  );
}
