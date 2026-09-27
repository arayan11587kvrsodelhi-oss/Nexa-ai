"use client";
import { useState, type FormEventHandler } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { NexaWordmark } from "@/components/shell/brand";
import { ShieldCheck } from "lucide-react";

export function ResetForm() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = confirm.length > 0 && password !== confirm;

  const onSubmit: FormEventHandler = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (!token) {
      setError("That password reset link is invalid or has expired. Please request a new one.");
      setBusy(false);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      setBusy(false);
      return;
    }
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error || "That password reset link is invalid or has expired. Please request a new one.");
        setBusy(false);
        return;
      }
      setDone(true);
    } catch {
      setError("Unable to reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center"><NexaWordmark /></div>
        <form onSubmit={onSubmit} className="nexa-panel rounded-panel border p-6" style={{ borderColor: "var(--nexa-border)" }} aria-labelledby="reset-heading">
          <h1 id="reset-heading" className="text-lg font-semibold nexa-text">Choose a new password</h1>
          <p className="mt-1 text-xs nexa-muted">At least 8 characters, up to 200.</p>
          {!token && !done ? (
            <p role="alert" className="nexa-wash-danger mt-4 rounded-control px-3 py-2 text-xs" style={{ color: "var(--nexa-danger-strong)" }}>
              That password reset link is invalid or has expired. Please <Link href="/forgot-password" className="underline">request a new one</Link>.
            </p>
          ) : null}
          {done ? (
            <div role="status" className="mt-5 rounded-control border px-3 py-3 text-xs leading-relaxed" style={{ borderColor: "var(--nexa-success-wash-line)", backgroundColor: "var(--nexa-success-wash)", color: "var(--nexa-text)" }}>
              Your password has been reset. Please <Link href="/login" className="text-teal-400 hover:underline">sign in with your new password</Link>.
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              <div>
                <label htmlFor="reset-password" className="mb-1 block text-xs font-medium nexa-muted">New password</label>
                <input id="reset-password" type="password" required minLength={8} maxLength={200} autoComplete="new-password" value={password} onChange={(ev) => setPassword(ev.target.value)} className="w-full rounded-control border bg-transparent px-3 py-2 text-sm nexa-text outline-none focus:border-teal-400" style={{ borderColor: "var(--nexa-border)" }} />
              </div>
              <div>
                <label htmlFor="reset-confirm" className="mb-1 block text-xs font-medium nexa-muted">Confirm new password</label>
                <input id="reset-confirm" type="password" required minLength={8} maxLength={200} autoComplete="new-password" value={confirm} onChange={(ev) => setConfirm(ev.target.value)} className="w-full rounded-control border bg-transparent px-3 py-2 text-sm nexa-text outline-none focus:border-teal-400" style={{ borderColor: "var(--nexa-border)" }} />
                {mismatch ? <p role="alert" className="mt-1 text-[11px]" style={{ color: "var(--nexa-danger-strong)" }}>Passwords do not match.</p> : null}
              </div>
            </div>
          )}
          {error ? (
            <p role="alert" className="nexa-wash-danger mt-4 rounded-control px-3 py-2 text-xs" style={{ color: "var(--nexa-danger-strong)" }}>{error}</p>
          ) : null}
          {done ? null : (
            <Button type="submit" variant="primary" className="mt-5 w-full justify-center" loading={busy} disabled={busy || mismatch}>
              {busy ? "Working…" : "Reset password"}
            </Button>
          )}
          <p className="mt-4 text-center text-xs nexa-muted"><Link href="/login" className="text-teal-400 hover:underline">Back to sign in</Link></p>
        </form>
        <p className="mt-6 flex items-center justify-center gap-1.5 text-[11px] nexa-muted"><ShieldCheck className="size-3.5 nexa-accent-text" aria-hidden />Local-first. Your data never leaves this machine.</p>
      </div>
    </div>
  );
}
