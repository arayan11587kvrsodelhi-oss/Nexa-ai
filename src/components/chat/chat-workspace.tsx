"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge, StatusDot } from "@/components/ui/badge";
import { ChatThread, type ThreadMsg } from "./chat-thread";
import { ChatComposer } from "./chat-composer";
import { ConversationList } from "./conversation-list";
import { useConversations } from "./use-conversations";
import { useModelsProbe } from "./use-models-probe";
import type { Conversation } from "@/types";

function frames(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const p = t.slice(5).trim();
    if (!p || p === "[DONE]") continue;
    try { out.push(JSON.parse(p) as Record<string, unknown>); } catch { /* keep-alive */ }
  }
  return out;
}

/** Messages are stored with the conversation they belong to. */
type LoadedMessages = { forId: string | null; list: ThreadMsg[] };

export function ChatWorkspace() {
  const router = useRouter();
  const params = useSearchParams();
  const activeId = params.get("c");
  const convs = useConversations();
  const mq = useModelsProbe();
  const [loaded, setLoaded] = useState<LoadedMessages>({ forId: null, list: [] });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Initial load runs once; refreshes resolve in promise callbacks.
  useEffect(() => {
    void (async () => {
      await Promise.resolve();
      await convs.refresh();
      await mq.refresh();
    })();
  }, []);

  // Load a conversation's messages. Errors surface through the async callback.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/conversations/${encodeURIComponent(activeId)}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = (await res.json()) as { messages: ThreadMsg[] };
        if (cancelled) return;
        setLoaded({
          forId: activeId,
          list: (d.messages || []).map((m) => ({ role: m.role, content: m.content, citations: m.citations })),
        });
        setChatError(null);
      } catch (e) {
        if (!cancelled) setChatError(e instanceof Error ? e.message : "Unable to load messages.");
      }
    };
    load().catch(() => {});
    return () => { cancelled = true; };
  }, [activeId]);

  // New chat from the shell: clear the thread and drop the ?c= parameter.
  useEffect(() => {
    const onNew = () => { router.replace("/chat"); setLoaded({ forId: null, list: [] }); };
    window.addEventListener("nexa:new-chat", onNew);
    return () => window.removeEventListener("nexa:new-chat", onNew);
  }, [router]);

  // While a new-conversation stream is running, accumulate locally.
  const [local, setLocal] = useState<{ forId: string | null; list: ThreadMsg[] } | null>(null);
  const messages = local ? local.list : (loaded.forId === activeId ? loaded.list : []);
  const setMessages = (next: ThreadMsg[] | ((p: ThreadMsg[]) => ThreadMsg[])) => {
    const base = local ? local.list : (loaded.forId === activeId ? loaded.list : []);
    const value = typeof next === "function" ? (next as (p: ThreadMsg[]) => ThreadMsg[])(base) : next;
    setLocal({ forId: activeId, list: value });
  };

  const pick = (id: string) => router.replace(`/chat?c=${encodeURIComponent(id)}`);
  const makeNew = async () => {
    try {
      const res = await fetch("/api/conversations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New Workspace Session" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { conversation: Conversation };
      await convs.refresh();
      router.replace(`/chat?c=${encodeURIComponent(d.conversation.id)}`);
    } catch (e) { setChatError(e instanceof Error ? e.message : "Unable to create conversation."); }
  };
  const send = async () => {
    const prompt = input.trim();
    if (!prompt || busy) return;
    setBusy(true); setChatError(null); setStreamText(""); setStatus("Sending…");
    setMessages((p) => [...p, { role: "user", content: prompt }]);
    setInput("");
    const ctl = new AbortController();
    abortRef.current = ctl;
    let acc = "";
    try {
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: activeId || undefined, messages: [{ role: "user", content: prompt }] }),
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error || `Chat request failed (HTTP ${res.status}).`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let doneId: string | null = null;
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        for (const ev of frames(dec.decode(step.value, { stream: true }))) {
          const t = String(ev.type || "");
          if (t === "token" && typeof ev.content === "string") { acc += ev.content; setStreamText(acc); setStatus(null); }
          else if (t === "action" && typeof ev.content === "string") setStatus(ev.content);
          else if (t === "error") throw new Error(typeof ev.content === "string" ? ev.content : "Provider error.");
          else if (t === "done") {
            const dd = ev.data as { conversationId?: string } | undefined;
            if (dd?.conversationId) doneId = dd.conversationId;
          }
        }
      }
      if (acc) setMessages((p) => [...p, { role: "assistant", content: acc }]);
      setStreamText("");
      await convs.refresh();
      if (doneId && doneId !== activeId) router.replace(`/chat?c=${encodeURIComponent(doneId)}`);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        if (acc) setMessages((p) => [...p, { role: "assistant", content: acc }]);
        setStreamText("");
      } else { setChatError(e instanceof Error ? e.message : "Chat failed."); setStreamText(""); }
    } finally { setBusy(false); setStatus(null); abortRef.current = null; }
  };
  const probe = mq.probe;
  const title = activeId ? convs.items.find((c) => c.id === activeId)?.title || "Conversation" : "New chat";
  return (
    <div className="flex h-full min-h-0">
      <ConversationList items={convs.items} activeId={activeId} error={convs.error} onSelect={pick} onNew={makeNew} />
      <section aria-label="Chat thread" className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: "var(--nexa-border)" }}>
          <h2 className="truncate text-xs font-medium nexa-text">{title}</h2>
          <span className="ml-auto">
            {probe ? (
              <Badge tone={probe.reachable ? "accent" : "warning"} mono>
                <StatusDot tone={probe.reachable ? "success" : "warning"} />
                {probe.isDemo ? "demo" : `${probe.provider || "provider"} · ${probe.modelName || "model?"}`}
              </Badge>) : <Badge tone="muted">checking model…</Badge>}
          </span>
        </div>
        <ChatThread messages={messages} streamText={streamText} status={status} error={chatError} />
        <ChatComposer value={input} busy={busy} onChange={setInput} onSend={() => void send()} onStop={() => abortRef.current?.abort()} />
      </section>
    </div>
  );
}
