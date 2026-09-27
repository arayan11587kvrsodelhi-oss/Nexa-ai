"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bot,
  Boxes,
  FileText,
  FlaskConical,
  FolderKanban,
  MessagesSquare,
  Settings,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Match nested routes, e.g. /settings/memory under /settings. */
  matchPrefix?: string;
}

const PRIMARY: NavItem[] = [
  { href: "/chat", label: "Chats", icon: MessagesSquare },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/files", label: "Files", icon: FileText },
  { href: "/models", label: "Models", icon: Boxes },
  { href: "/playground", label: "Playground", icon: FlaskConical },
  { href: "/agents", label: "Agents", icon: Bot },
];

const SECONDARY: NavItem[] = [
  { href: "/settings", label: "Settings", icon: Settings, matchPrefix: "/settings" },
];

function NavLink({
  item,
  active,
  onNavigate,
  badge,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
  badge?: string;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-2.5 rounded-control px-2.5 py-2 text-[13px] nexa-hoverable",
        active ? "nexa-text" : "nexa-muted hover:text-ink-200"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full transition-opacity",
          active ? "nexa-accent-text opacity-100" : "opacity-0"
        )}
        style={{ backgroundColor: "var(--nexa-accent)" }}
      />
      <Icon
        className={cn(
          "size-4 shrink-0",
          active ? "nexa-accent-text" : "nexa-muted group-hover:text-ink-300"
        )}
        aria-hidden
      />
      <span className="truncate">{item.label}</span>
      {badge ? (
        <span className="nexa-raised ml-auto rounded-full px-1.5 py-px font-mono text-[10px] nexa-muted">
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

export function SidebarNav({
  onNavigate,
  counts,
}: {
  onNavigate?: () => void;
  counts?: Partial<Record<"chats" | "projects" | "files" | "agents", number>>;
}) {
  const pathname = usePathname();

  const isActive = (item: NavItem) => {
    if (item.href === "/chat") return pathname === "/chat" || pathname.startsWith("/chat/") || pathname === "/" || pathname.startsWith("/c/");
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
  };

  return (
    <nav aria-label="Workspace" className="flex flex-col gap-1">
      {PRIMARY.map((item) => (
        <NavLink
          key={item.href}
          item={item}
          active={isActive(item)}
          onNavigate={onNavigate}
          badge={
            item.href === "/chat"
              ? counts?.chats?.toString()
              : item.href === "/projects"
                ? counts?.projects?.toString()
                : item.href === "/files"
                  ? counts?.files?.toString()
                  : undefined
          }
        />
      ))}

      <div className="my-2 h-px" style={{ backgroundColor: "var(--nexa-border)" }} />

      {SECONDARY.map((item) => (
        <NavLink
          key={item.href}
          item={item}
          active={
            item.matchPrefix ? pathname.startsWith(item.matchPrefix) : false
          }
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  );
}

export const SIDEBAR_PRIMARY_ITEMS = PRIMARY;