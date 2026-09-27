"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LogOut, UserRound } from "lucide-react";

interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
}

/**
 * Account footer for the workspace shell.
 *
 * Shows the signed-in identity and performs logout by clearing the session
 * server-side (the HttpOnly cookie is replaced by the API; nothing session
 * related is ever stored in localStorage).
 */
export function AccountMenu() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { user: CurrentUser };
        if (!cancelled) setUser(data.user);
      } catch {
        // Unreachable server — leave the menu hidden rather than showing junk.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!user) return null;

  const logout = async () => {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  };

  return (
    <div className="flex items-center gap-2 px-3.5 py-2.5">
      <span
        className="flex size-7 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: "var(--nexa-accent)", color: "var(--nexa-accent-contrast)" }}
        aria-hidden
      >
        <UserRound className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium nexa-text">
          {user.name || user.email.split("@")[0]}
        </p>
        <p className="truncate text-[11px] nexa-muted">{user.email}</p>
      </div>
      <button
        type="button"
        onClick={logout}
        disabled={busy}
        aria-label={busy ? "Signing out" : "Sign out"}
        className="flex size-7 items-center justify-center rounded-control nexa-muted nexa-hoverable hover:text-ink-100"
      >
        <LogOut className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

/** Inline link variant for pages that live outside the shell (e.g. settings). */
export function AccountSignOutLink() {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const logout = async () => {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  };

  return (
    <Link
      href="#"
      onClick={(e) => {
        e.preventDefault();
        void logout();
      }}
      className="text-xs text-teal-400 hover:underline"
    >
      {busy ? "Signing out…" : "Sign out"}
    </Link>
  );
}
