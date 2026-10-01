"use client";

import { useState, type FormEventHandler } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { NexaWordmark } from "@/components/shell/brand";
import { ShieldCheck } from "lucide-react";

/**
 * Shared client logic for /login and /signup.
 * Kept in one module so the two pages stay behaviorally identical.
 */
export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSignup = mode === "signup";

  const onSubmit: FormEventHandler = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(isSignup ? "/api/auth/signup" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isSignup ? { email, password, name: name || undefined } : { email, password }
        ),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setBusy(false);
        return;
      }
      const next = params.get("next");
      router.replace(next && next.startsWith("/") ? next : "/");
      router.refresh();
    } catch {
      setError("Unable to reach the server. Please try again.");
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <NexaWordmark />
        </div>

        <form
          onSubmit={onSubmit}
          className="nexa-panel rounded-panel border p-6"
          style={{ borderColor: "var(--nexa-border)" }}
          aria-labelledby="auth-heading"
        >
          <h1 id="auth-heading" className="text-lg font-semibold nexa-text">
            {isSignup ? "Create your NEXA account" : "Sign in to NEXA"}
          </h1>
          <p className="mt-1 text-xs nexa-muted">
            {isSignup
              ? "One local account for your private workspace."
              : "Your private AI workspace awaits."}
          </p>

          <div className="mt-5 space-y-3">
            {isSignup ? (
              <div>
                <label htmlFor="auth-name" className="mb-1 block text-xs font-medium nexa-muted">
                  Name <span className="opacity-60">(optional)</span>
                </label>
                <input
                  id="auth-name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-control border bg-transparent px-3 py-2 text-sm nexa-text outline-none focus:border-teal-400"
                  style={{ borderColor: "var(--nexa-border)" }}
                />
              </div>
            ) : null}

            <div>
              <label htmlFor="auth-email" className="mb-1 block text-xs font-medium nexa-muted">
                Email
              </label>
              <input
                id="auth-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-control border bg-transparent px-3 py-2 text-sm nexa-text outline-none focus:border-teal-400"
                style={{ borderColor: "var(--nexa-border)" }}
              />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <label htmlFor="auth-password" className="block text-xs font-medium nexa-muted">
                  Password
                </label>
                {isSignup ? null : (
                  <Link href="/forgot-password" className="text-[11px] text-teal-400 hover:underline">
                    Forgot password?
                  </Link>
                )}
              </div>
              <input
                id="auth-password"
                type="password"
                required
                minLength={isSignup ? 8 : undefined}
                autoComplete={isSignup ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-control border bg-transparent px-3 py-2 text-sm nexa-text outline-none focus:border-teal-400"
                style={{ borderColor: "var(--nexa-border)" }}
              />
              {isSignup ? (
                <p className="mt-1 text-[11px] nexa-muted">At least 8 characters.</p>
              ) : null}
            </div>
          </div>

          {error ? (
            <p role="alert" className="nexa-wash-danger mt-4 rounded-control px-3 py-2 text-xs" style={{ color: "var(--nexa-danger-strong)" }}>
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            className="mt-5 w-full justify-center"
            loading={busy}
            disabled={busy}
          >
            {busy ? "Working…" : isSignup ? "Create account" : "Sign in"}
          </Button>

          <p className="mt-4 text-center text-xs nexa-muted">
            {isSignup ? (
              <>
                Already have an account?{" "}
                <Link href="/login" className="text-teal-400 hover:underline">
                  Sign in
                </Link>
              </>
            ) : (
              <>
                New to NEXA?{" "}
                <Link href="/signup" className="text-teal-400 hover:underline">
                  Create an account
                </Link>
              </>
            )}
          </p>
        </form>

        <p className="mt-6 flex items-center justify-center gap-1.5 text-[11px] nexa-muted">
          <ShieldCheck className="size-3.5 nexa-accent-text" aria-hidden />
          Local-first workspace. Your stored workspace data remains in your configured
          PostgreSQL database. If an external AI provider is configured, prompts and
          relevant content may be sent to that provider for inference.
        </p>
      </div>
    </div>
  );
}
