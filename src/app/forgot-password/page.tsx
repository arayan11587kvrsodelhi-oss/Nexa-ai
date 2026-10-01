"use client";

import { Suspense, useState, type FormEventHandler } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { NexaWordmark } from "@/components/shell/brand";
import { ShieldCheck } from "lucide-react";

function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [devUrl, setDevUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSubmit: FormEventHandler = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        developmentResetUrl?: string;
      };
      if (!res.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setBusy(false);
        return;
      }
      setDone(true);
      setDevUrl(typeof data.developmentResetUrl === "string" ? data.developmentResetUrl : null);
    } catch {
      setError("Unable to reach the server. Please try again.");
    } finally {
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
          aria-labelledby="forgot-heading"
        >
          <h1 id="forgot-heading" className="text-lg font-semibold nexa-text">
            Reset your password
          </h1>
          <p className="mt-1 text-xs nexa-muted">
            Enter your account email and we will prepare a reset link.
          </p>
          {done ? (
            <div
              role="status"
              className="mt-5 rounded-control border px-3 py-3 text-xs leading-relaxed"
              style={{
                borderColor: "var(--nexa-success-wash-line)",
                backgroundColor: "var(--nexa-success-wash)",
                color: "var(--nexa-text)",
              }}
            >
              If an account exists for that email, you will receive instructions to reset your password.
              {devUrl ? (
                <span
                  className="mt-2 block rounded-control border px-2 py-2"
                  style={{
                    borderColor: "var(--nexa-warn-wash-line)",
                    backgroundColor: "var(--nexa-warn-wash)",
                  }}
                >
                  <span className="font-semibold">Development only:</span> no email was sent. Use this local reset link:{" "}
                  <Link href={devUrl} className="break-all text-teal-400 hover:underline">
                    {devUrl}
                  </Link>
                </span>
              ) : null}
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              <div>
                <label htmlFor="forgot-email" className="mb-1 block text-xs font-medium nexa-muted">
                  Email
                </label>
                <input
                  id="forgot-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(ev) => setEmail(ev.target.value)}
                  className="w-full rounded-control border bg-transparent px-3 py-2 text-sm nexa-text outline-none focus:border-teal-400"
                  style={{ borderColor: "var(--nexa-border)" }}
                />
              </div>
            </div>
          )}
          {error ? (
            <p role="alert" className="nexa-wash-danger mt-4 rounded-control px-3 py-2 text-xs" style={{ color: "var(--nexa-danger-strong)" }}>
              {error}
            </p>
          ) : null}
          {done ? null : (
            <Button type="submit" variant="primary" className="mt-5 w-full justify-center" loading={busy} disabled={busy}>
              {busy ? "Working…" : "Send reset link"}
            </Button>
          )}
          <p className="mt-4 text-center text-xs nexa-muted">
            <Link href="/login" className="text-teal-400 hover:underline">
              Back to sign in
            </Link>
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

export default function ForgotPasswordPage() {
  return (
    <Suspense>
      <ForgotPasswordForm />
    </Suspense>
  );
}
