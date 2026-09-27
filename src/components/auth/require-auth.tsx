"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { SkeletonLines } from "@/components/ui/feedback";
import { Button } from "@/components/ui/button";

/** Client-side auth gate: probes /api/auth/me, shows sign-in CTA on 401. */
export function RequireAuth({ children, next }: { children: ReactNode; next?: string }) {
  const [state, setState] = useState<"checking" | "ok" | "denied">("checking");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        if (!cancelled) setState(res.ok ? "ok" : "denied");
      } catch {
        if (!cancelled) setState("denied");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "checking") {
    return (
      <div className="mx-auto w-full max-w-3xl px-5 py-10" role="status" aria-label="Checking session">
        <SkeletonLines count={4} />
      </div>
    );
  }

  if (state === "denied") {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3 px-5 py-16 text-center">
        <h1 className="text-base font-semibold nexa-text">Sign in required</h1>
        <p className="text-xs leading-relaxed nexa-muted">
          This workspace page needs an authenticated session. Sign in to continue — your data stays on this host.
        </p>
        <Link href={`/login?next=${encodeURIComponent(next || "/chat")}`}>
          <Button variant="primary" size="md">Sign in</Button>
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}
