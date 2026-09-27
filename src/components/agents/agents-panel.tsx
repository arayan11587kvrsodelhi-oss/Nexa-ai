"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback";
import { AgentsTools as AgentsToolsSection } from "./agents-tools";
import { AgentsRuns as AgentsRunsSection } from "./agents-runs";
import type { AgentRunItem, ToolDefinition } from "@/types";

export function AgentsPanel() {
  const [tools, setTools] = useState<ToolDefinition[] | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [runs, setRuns] = useState<AgentRunItem[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  /**
   * Fetches the tool registry and this user's run history.
   * Every `setState` below is preceded by an `await`, so no state is written
   * synchronously when the mount effect calls this.
   */
  const load = async () => {
    try {
      const r = await fetch("/api/tools", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as { tools: ToolDefinition[] };
      setTools(d.tools || []);
      setToolsError(null);
    } catch (e) {
      setToolsError(e instanceof Error ? e.message : "Tools unavailable.");
    }
    try {
      const r = await fetch("/api/agents", { cache: "no-store" });
      // A 404 means this installation exposes no run-history route: an honest
      // empty list, not an error and not invented runs.
      if (r.status === 404) { setRuns([]); setRunsError(null); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as { runs?: AgentRunItem[] };
      setRuns(d.runs || []);
      setRunsError(null);
    } catch (e) {
      setRunsError(e instanceof Error ? e.message : "History unavailable.");
    }
  };

  useEffect(() => {
    // The load runs in a promise continuation, so no state is written
    // synchronously during the effect's first commit.
    void (async () => {
      await Promise.resolve();
      await load();
    })();
  }, []);
  const run = async () => {
    const g = goal.trim();
    if (!g || busy) return;
    setBusy(true); setResult(null); setRunError(null);
    try {
      const res = await fetch("/api/agents", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: g }),
      });
      const d = (await res.json().catch(() => ({}))) as { result?: string; error?: string };
      if (!res.ok) throw new Error(d.error || `Agent run failed (HTTP ${res.status}).`);
      setResult(typeof d.result === "string" ? d.result : "Run completed with no result text.");
      setGoal("");
      void load();
    } catch (e) { setRunError(e instanceof Error ? e.message : "Run failed."); }
    finally { setBusy(false); }
  };
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 py-6">
      <div>
        <h1 className="text-base font-semibold nexa-text">Agents</h1>
        <p className="mt-1 text-xs nexa-muted">Goals run through the existing orchestrator and real tool calls. No agent CRUD API exists yet — runs execute on demand and history shows only when the backend provides it.</p>
      </div>
      <form className="nexa-overlay rounded-panel border p-4" style={{ borderColor: "var(--nexa-border)" }}
        onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <label htmlFor="agent-goal" className="mb-1 block text-xs font-medium nexa-text">Goal</label>
        <textarea id="agent-goal" rows={2} value={goal} onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. What time is it in UTC, and what is 18 * 24?"
          className="w-full rounded-control border bg-transparent px-3 py-2 text-sm nexa-text outline-none focus:border-teal-400"
          style={{ borderColor: "var(--nexa-border)" }} />
        <div className="mt-3 flex items-center gap-2">
          <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!goal.trim()}>Run goal</Button>
          <span className="text-[11px] nexa-muted">Runs POST /api/agents with your session.</span>
        </div>
      </form>
      {result ? (
        <div className="rounded-panel border px-4 py-3" style={{ borderColor: "var(--nexa-border)" }}>
          <p className="text-xs font-medium nexa-text">Latest run result</p>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-relaxed nexa-text">{result}</pre>
        </div>) : null}
      {runError ? <ErrorState title="Agent run failed" message={runError} /> : null}
      <AgentsToolsSection tools={tools} error={runError || toolsError} onRetry={() => void load()} />
      <AgentsRunsSection runs={runs} error={runsError} onRetry={() => void load()} />
    </div>
  );
}
