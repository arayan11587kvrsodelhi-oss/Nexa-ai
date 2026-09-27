"use client";
import { Plus } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/types";
export function ConversationList({ items, activeId, error, onSelect, onNew }: {
  items: Conversation[]; activeId: string | null; error: string | null;
  onSelect: (id: string) => void; onNew: () => void;
}) {
  return (
    <aside aria-label="Conversations" className="hidden w-64 shrink-0 flex-col border-r md:flex" style={{ borderColor: "var(--nexa-border)" }}>
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-xs font-medium nexa-muted">Conversations</span>
        <IconButton label="New conversation" icon={<Plus className="size-4" aria-hidden />} onClick={onNew} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {error ? <ErrorState title="Conversations unavailable" message={error} />
        : items.length === 0 ? <p className="px-2 py-4 text-xs nexa-muted">No conversations yet. Start one below.</p>
        : (<ul className="flex flex-col gap-0.5">{items.map((c) => (
          <li key={c.id}><button type="button" onClick={() => onSelect(c.id)} aria-current={c.id === activeId ? "page" : undefined}
            className={cn("w-full truncate rounded-control px-2.5 py-2 text-left text-xs nexa-hoverable",
              c.id === activeId ? "nexa-text nexa-raised" : "nexa-muted hover:text-ink-200")}>{c.title || "Untitled"}</button></li>))}
        </ul>)}
      </div>
    </aside>
  );
}
