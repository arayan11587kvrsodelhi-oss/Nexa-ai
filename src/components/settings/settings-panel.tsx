"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AccountSignOutLink } from "@/components/auth/account-menu";
import { SkeletonLines } from "@/components/ui/feedback";

export function SettingsPanel() {
  const [user, setUser] = useState<{ email: string; name: string | null } | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        if (!res.ok) return;
        const d = (await res.json()) as { user: { email: string; name: string | null } };
        setUser(d.user);
      } catch { /* the auth gate already handled the session */ }
    })();
  }, []);
  const rows = [
    { href: "/settings/models", title: "Models", desc: "Active provider, reachability, discovered models." },
    { href: "/settings/memory", title: "Memory", desc: "Stored preferences, facts, and instructions." },
    { href: "/settings/api-keys", title: "API keys", desc: "Keys for the OpenAI-compatible /v1 endpoints." },
  ];
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 py-6">
      <div>
        <h1 className="text-base font-semibold nexa-text">Settings</h1>
        <p className="mt-1 text-xs nexa-muted">Account and workspace configuration. Values shown here come from the server — no placeholder settings.</p>
      </div>
      <section aria-label="Account" className="nexa-overlay rounded-panel border px-4 py-3" style={{ borderColor: "var(--nexa-border)" }}>
        <h2 className="text-xs font-medium nexa-text">Account</h2>
        {!user ? <div className="mt-2"><SkeletonLines count={2} /></div> : (
          <div className="mt-1 flex items-center gap-2 text-xs nexa-muted">
            <span className="nexa-text">{user.name || user.email.split("@")[0]}</span>
            <span>{user.email}</span>
            <span className="ml-auto"><AccountSignOutLink /></span>
          </div>
        )}
      </section>
      <nav aria-label="Settings sections">
        <ul className="grid gap-2 sm:grid-cols-2">
          {rows.map((r) => (
            <li key={r.href}>
              <Link href={r.href} className="block rounded-panel border px-4 py-3 nexa-hoverable" style={{ borderColor: "var(--nexa-border)" }}>
                <span className="text-sm font-medium nexa-text">{r.title}</span>
                <span className="mt-0.5 block text-[11px] nexa-muted">{r.desc}</span>
              </Link>
            </li>))}
        </ul>
      </nav>
    </div>
  );
}
