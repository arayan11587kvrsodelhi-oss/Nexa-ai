"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Command, Menu, Moon, Plus, Sun, X } from "lucide-react";
import { NexaWordmark } from "./brand";
import { SidebarNav } from "./sidebar-nav";
import { AccountMenu } from "@/components/auth/account-menu";
import { Button, IconButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ShellSlotProps {
  /** Rendered inside the sidebar above navigation. */
  sidebarHeader?: ReactNode;
  /** Rendered inside the sidebar below navigation (scrollable). */
  sidebarBody?: ReactNode;
  /** Rendered pinned to the bottom of the sidebar. */
  sidebarFooter?: ReactNode;
}

const themeListeners = new Set<() => void>();

function subscribeToTheme(listener: () => void) {
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
}

/** Reads the theme the bootstrap script already applied to <html>. */
function readAppliedTheme(): "dark" | "light" {
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "light"
    : "dark";
}

function ThemeToggle() {
  const theme = useSyncExternalStore(
    subscribeToTheme,
    readAppliedTheme,
    () => "dark" as const
  );

  const toggle = useCallback(() => {
    const next = readAppliedTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("nexa.theme", next);
    } catch {
      // Storage can be unavailable (private mode); the theme still applies for this session.
    }
    themeListeners.forEach((listener) => listener());
  }, []);

  return (
    <IconButton
      label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      onClick={toggle}
      icon={
        theme === "dark" ? (
          <Sun className="size-3.5" aria-hidden />
        ) : (
          <Moon className="size-3.5" aria-hidden />
        )
      }
    />
  );
}

function SidebarContent({
  onNavigate,
  onNewChat,
  onOpenPalette,
  props,
}: {
  onNavigate?: () => void;
  onNewChat: () => void;
  onOpenPalette: () => void;
  props: ShellSlotProps;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col nexa-text">
      <div className="flex items-center justify-between gap-2 px-3.5 pt-3.5 pb-3">
        <NexaWordmark />
        <ThemeToggle />
      </div>

      <div className="px-3 pb-2">
        <Button
          variant="primary"
          size="sm"
          onClick={onNewChat}
          icon={<Plus className="size-3.5" aria-hidden />}
          className="w-full justify-center"
        >
          New chat
        </Button>
      </div>

      <div className="px-2 pb-2">
        <SidebarNav onNavigate={onNavigate} />
      </div>

      <div
        className="mx-3 my-1 h-px"
        style={{ backgroundColor: "var(--nexa-border)" }}
      />

      {props.sidebarHeader ? (
        <div className="px-2">{props.sidebarHeader}</div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {props.sidebarBody}
      </div>

      {props.sidebarFooter ? (
        <div className="border-t" style={{ borderColor: "var(--nexa-border)" }}>
          {props.sidebarFooter}
        </div>
      ) : null}

      <div className="border-t" style={{ borderColor: "var(--nexa-border)" }}>
          <AccountMenu />
        </div>

      <div
        className="border-t px-3 py-2.5"
        style={{ borderColor: "var(--nexa-border)" }}
      >
        <button
          type="button"
          onClick={onOpenPalette}
          className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-[11px] nexa-muted nexa-hoverable hover:text-ink-300"
        >
          <Command className="size-3 shrink-0" aria-hidden />
          <span>Command palette</span>
          <kbd className="nexa-raised ml-auto rounded px-1 font-mono text-[10px] nexa-muted">
            ⌘K
          </kbd>
        </button>
      </div>
    </div>
  );
}

/**
 * The NEXA workspace frame.
 *
 * Desktop: fixed 272px sidebar, chat fills the rest.
 * Mobile: the sidebar becomes a modal drawer opened from the top bar.
 */
export function AppShell({
  children,
  title,
  actions,
  ...props
}: ShellSlotProps & {
  children: ReactNode;
  title?: ReactNode;
  actions?: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const router = useRouter();
  const drawerRef = useRef<HTMLDivElement>(null);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const onNewChat = useCallback(() => {
    closeDrawer();
    // Canonical chat route; the workspace root also hosts the landing panel.
    if (window.location.pathname === "/chat") {
      window.dispatchEvent(new CustomEvent("nexa:new-chat"));
      return;
    }
    router.push("/chat");
  }, [router, closeDrawer]);

  const onOpenPalette = useCallback(() => {
    window.dispatchEvent(new CustomEvent("nexa:open-palette"));
  }, []);

  // Lock scroll + Escape close for the mobile drawer.
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    drawerRef.current?.querySelector<HTMLElement>("button,a")?.focus();
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [drawerOpen]);

  return (
    <div className="relative z-10 flex h-dvh w-full overflow-hidden">
      {/* ---------- Desktop sidebar ---------- */}
      <aside
        aria-label="Sidebar"
        className="hidden w-68 shrink-0 nexa-panel md:flex md:flex-col"
        style={{ borderRight: "1px solid var(--nexa-border)" }}
      >
        <SidebarContent
          onNewChat={onNewChat}
          onOpenPalette={onOpenPalette}
          props={props}
        />
      </aside>

      {/* ---------- Mobile drawer ---------- */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-80 md:hidden">
          <div
            className="absolute inset-0 bg-obsidian-950/80 backdrop-blur-sm"
            onClick={closeDrawer}
            aria-hidden
          />
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="nexa-enter absolute inset-y-0 left-0 w-72 max-w-[85vw] nexa-surface"
            style={{ borderRight: "1px solid var(--nexa-border)" }}
          >
            <IconButton
              label="Close navigation"
              onClick={closeDrawer}
              icon={<X className="size-4" aria-hidden />}
              className="absolute right-2.5 top-3.5"
            />
            <SidebarContent
              onNavigate={closeDrawer}
              onNewChat={onNewChat}
              onOpenPalette={() => {
                closeDrawer();
                onOpenPalette();
              }}
              props={props}
            />
          </div>
        </div>
      ) : null}

      {/* ---------- Main column ---------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex h-14 shrink-0 items-center gap-2 nexa-bar px-3 md:px-5"
          style={{ borderBottom: "1px solid var(--nexa-border)" }}
        >
          <IconButton
            label="Open navigation"
            onClick={() => setDrawerOpen(true)}
            icon={<Menu className="size-4" aria-hidden />}
            className="-ml-1 md:hidden"
          />
          {/* Brand mark only: the sidebar behind the drawer already carries the wordmark. */}
          <div className="md:hidden">
            <NexaWordmark collapsed />
          </div>

          <div className="min-w-0 flex-1 md:flex md:items-center md:gap-3">
            {typeof title === "string" ? (
              <h1 className="truncate text-sm font-medium nexa-text">{title}</h1>
            ) : (
              title
            )}
          </div>

          <div className={cn("flex shrink-0 items-center gap-1.5")}>{actions}</div>
        </header>

        <main
          id="nexa-main"
          className="relative min-h-0 flex-1 overflow-hidden"
          tabIndex={-1}
        >
          {children}
        </main>
      </div>
    </div>
  );
}