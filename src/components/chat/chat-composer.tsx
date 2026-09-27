"use client";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
export function ChatComposer({ value, busy, onChange, onSend, onStop }: {
  value: string; busy: boolean;
  onChange: (v: string) => void; onSend: () => void; onStop: () => void;
}) {
  return (
    <form className="border-t px-4 py-3" style={{ borderColor: "var(--nexa-border)" }}
      onSubmit={(e) => { e.preventDefault(); onSend(); }}>
      <div className="mx-auto flex w-full max-w-2xl items-end gap-2">
        <label htmlFor="chat-input" className="sr-only">Message</label>
        <textarea id="chat-input" value={value} onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
          rows={2} placeholder="Ask anything… (Enter to send, Shift+Enter for newline)"
          className="max-h-32 min-h-10 flex-1 resize-y rounded-control border bg-transparent px-3 py-2 text-sm nexa-text outline-none focus:border-teal-400"
          style={{ borderColor: "var(--nexa-border)" }} />
        {busy ? (
          <Button type="button" variant="secondary" size="md" onClick={onStop} icon={<Square className="size-3.5" aria-hidden />}>Stop</Button>
        ) : (
          <Button type="submit" variant="primary" size="md" disabled={!value.trim()} icon={<ArrowUp className="size-3.5" aria-hidden />}>Send</Button>
        )}
      </div>
    </form>
  );
}
