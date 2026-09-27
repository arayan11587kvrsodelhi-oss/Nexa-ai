"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
export function PlaygroundForm() {
  const [prompt, setPrompt] = useState("Say hello in one sentence.");
  const [answer, setAnswer] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const send = async () => {
    const p = prompt.trim();
    if (!p || sending) return;
    setSending(true); setAnswer(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: p }] }),
      });
      if (!res.ok || !res.body) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = "";
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        for (const line of dec.decode(step.value, { stream: true }).split("\n")) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const ev = JSON.parse(payload) as { type?: string; content?: string };
            if (ev.type === "token" && ev.content) { acc += ev.content; setAnswer(acc); }
            if (ev.type === "error") throw new Error(ev.content || "Provider error.");
          } catch { /* partial frame */ }
        }
      }
      if (!acc) setAnswer("(empty response)");
    } catch (e) { setAnswer(`Error: ${e instanceof Error ? e.message : "failed"}`); }
    finally { setSending(false); }
  };
  return (
    <div>
      <form className="rounded-panel border p-4" style={{ borderColor: "var(--nexa-border)" }}
        onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label htmlFor="pg-prompt" className="mb-1 block text-xs font-medium nexa-text">Test prompt</label>
        <textarea id="pg-prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)}
          className="w-full rounded-control border bg-transparent px-3 py-2 text-sm nexa-text outline-none focus:border-teal-400"
          style={{ borderColor: "var(--nexa-border)" }} />
        <div className="mt-3">
          <Button type="submit" variant="primary" size="sm" loading={sending} disabled={!prompt.trim()}>Send test prompt</Button>
        </div>
      </form>
      {answer !== null ? (
        <div className="mt-3 rounded-panel border px-4 py-3" style={{ borderColor: "var(--nexa-border)" }}>
          <p className="text-xs font-medium nexa-text">Response</p>
          <p className="mt-1 whitespace-pre-wrap text-sm nexa-text">{answer}</p>
        </div>
      ) : null}
    </div>
  );
}
