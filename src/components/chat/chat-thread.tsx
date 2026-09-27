"use client";
import { Loader2 } from "lucide-react";
import { EmptyState, ErrorState } from "@/components/ui/feedback";
import { cn } from "@/lib/utils";

export interface ThreadMsg {
  role: string; content: string;
  citations?: Array<{ title: string; snippet: string; sourceType: string }>;
}

export function ChatThread({ messages, streamText, status, error, emptyHint }: {
  messages: ThreadMsg[]; streamText: string; status: string | null;
  error: string | null; emptyHint?: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" role="log" aria-label="Messages" aria-live="polite">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
        {messages.length === 0 && !streamText ? (
          <EmptyState title="Start a new conversation"
            description={emptyHint || "Messages stream from POST /api/chat with your real provider. Nothing here is simulated."} />
        ) : messages.map((m, i) => (
          <article key={i} aria-label={m.role === "user" ? "Your message" : "Assistant message"}
            className={cn("rounded-panel border px-3.5 py-2.5 text-sm leading-relaxed",
              m.role === "user" ? "nexa-raised ml-8" : "nexa-overlay mr-8")}
            style={{ borderColor: "var(--nexa-border)" }}>
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wider nexa-muted">{m.role}</p>
            <p className="whitespace-pre-wrap nexa-text">{m.content}</p>
            {m.citations && m.citations.length > 0 ? (
              <ul className="mt-2 space-y-1 border-t pt-2" style={{ borderColor: "var(--nexa-border)" }}>
                {m.citations.map((c, j) => (
                  <li key={j} className="text-[11px] nexa-muted">[{c.sourceType}] {c.title} — {c.snippet.slice(0, 140)}</li>
                ))}
              </ul>) : null}
          </article>
        ))}
        {streamText ? (
          <article aria-label="Streaming response" className="nexa-overlay mr-8 rounded-panel border px-3.5 py-2.5 text-sm" style={{ borderColor: "var(--nexa-border)" }}>
            <p className="mb-1 flex items-center gap-1.5 text-[10px] uppercase nexa-muted"><Loader2 className="size-3 animate-spin" aria-hidden /> streaming</p>
            <p className="whitespace-pre-wrap nexa-text">{streamText}</p>
          </article>) : null}
        {status ? <p className="text-[11px] nexa-muted" role="status">{status}</p> : null}
        {error ? <ErrorState title="Chat failed" message={error} /> : null}
      </div>
    </div>
  );
}
