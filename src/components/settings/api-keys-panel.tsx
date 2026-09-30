"use client";

/**
 * API key management.
 *
 * Security posture of this component, which is the whole reason it is written
 * this way:
 *
 *  - the plaintext key exists in React state **only** while the one-time reveal
 *    is open. It is never written to localStorage, sessionStorage, a cookie, the
 *    URL, or any analytics event, and it is dropped when the dialog closes;
 *  - the list renders only server-provided metadata. The digest and the pepper
 *    are never part of any response this component can read;
 *  - "last used" is shown only when the backend actually recorded one. An unused
 *    key says "never used" rather than implying activity.
 */
import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { EmptyState, ErrorState, SkeletonLines } from "@/components/ui/feedback";
import { formatRelativeTime } from "@/lib/utils";
import { ApiDocsSection } from "./api-docs";

interface ApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  status: "active" | "revoked" | "expired";
}

export function ApiKeysPanel() {
  const [keys, setKeys] = useState<ApiKeyView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // The one and only place the plaintext is allowed to live.
  const [reveal, setReveal] = useState<{ name: string; plaintext: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokeTarget, setRevokeTarget] = useState<ApiKeyView | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/api-keys", { cache: "no-store" });
      if (res.status === 401) {
        setError("You need to sign in to manage API keys.");
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { keys?: ApiKeyView[] };
      setKeys(data.keys ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load API keys.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Runs in a promise continuation: no synchronous state write on mount.
    void (async () => {
      await Promise.resolve();
      await load();
    })();
  }, [load]);

  const createKey = async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        plaintext?: string;
        key?: ApiKeyView;
        error?: string;
      };
      if (!res.ok || !data.plaintext) {
        setCreateError(data.error ?? "That key could not be created.");
        return;
      }
      setCreateOpen(false);
      setName("");
      setReveal({ name: data.key?.name ?? trimmed, plaintext: data.plaintext });
      setCopied(false);
      await load();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "That key could not be created.");
    } finally {
      setCreating(false);
    }
  };

  const dismissReveal = useCallback(() => {
    setReveal((current) => {
      if (current) current.plaintext = "";
      return null;
    });
    setCopied(false);
  }, []);

  const copyKey = async () => {
    if (!reveal) return;
    try {
      await navigator.clipboard.writeText(reveal.plaintext);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const revoke = async () => {
    const target = revokeTarget;
    if (!target || revoking) return;
    setRevoking(true);
    try {
      const res = await fetch(`/api/api-keys/${encodeURIComponent(target.id)}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      setRevokeTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That key could not be revoked.");
    } finally {
      setRevoking(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 py-6">
      <div>
        <h1 className="text-base font-semibold nexa-text">API keys</h1>
        <p className="mt-1 text-xs nexa-muted">
          Keys authenticate the OpenAI-compatible{" "}
          <code className="font-mono">/v1</code> endpoints. Only a hash is
          stored, so a key cannot be shown again after it is created.
        </p>
      </div>

      <div>
        <Button
          variant="primary"
          size="md"
          icon={<Plus className="size-3.5" aria-hidden />}
          onClick={() => {
            setCreateError(null);
            setCreateOpen(true);
          }}
        >
          Create API key
        </Button>
      </div>

      {loading ? <SkeletonLines count={3} /> : null}

      {error ? (
        <ErrorState title="API keys unavailable" message={error} onRetry={() => void load()} />
      ) : null}

      {!loading && keys && keys.length === 0 ? (
        <EmptyState
          icon={<KeyRound className="size-4" aria-hidden />}
          title="No API keys yet"
          description="Create one to call the NEXA API from a script or another application."
        />
      ) : null}

      {!loading && keys && keys.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {keys.map((key) => {
            const active = key.status === "active";
            return (
              <li
                key={key.id}
                className="rounded-panel border px-4 py-3"
                style={{ borderColor: "var(--nexa-border)" }}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm nexa-text">{key.name}</span>
                  <Badge tone={active ? "accent" : "muted"}>{key.status}</Badge>
                  <span className="font-mono text-[11px] nexa-muted">{key.keyPrefix}</span>
                </div>
                <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-[11px] nexa-muted sm:grid-cols-2">
                  <div className="flex gap-1.5">
                    <dt>Created</dt>
                    <dd className="nexa-text">{formatRelativeTime(key.createdAt)}</dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt>Last used</dt>
                    <dd className="nexa-text">
                      {key.lastUsedAt ? formatRelativeTime(key.lastUsedAt) : "never used"}
                    </dd>
                  </div>
                  {key.revokedAt ? (
                    <div className="flex gap-1.5">
                      <dt>Revoked</dt>
                      <dd className="nexa-text">{formatRelativeTime(key.revokedAt)}</dd>
                    </div>
                  ) : null}
                </dl>
                {active ? (
                  <div className="mt-2.5">
                    <Button
                      size="sm"
                      variant="danger"
                      icon={<Trash2 className="size-3.5" aria-hidden />}
                      onClick={() => setRevokeTarget(key)}
                    >
                      Revoke
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <ApiDocsSection />

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create API key"
        description="Give the key a name so you can tell what it is for."
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={creating}
              disabled={!name.trim()}
              onClick={() => void createKey()}
            >
              Create key
            </Button>
          </>
        }
      >
        <label htmlFor="api-key-name" className="sr-only">
          Key name
        </label>
        <input
          id="api-key-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My local NEXA integration"
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-control border bg-transparent px-3 py-2 text-sm nexa-text outline-none focus:border-teal-400"
          style={{ borderColor: "var(--nexa-border)" }}
        />
        {createError ? (
          <p role="alert" className="mt-2 text-xs" style={{ color: "var(--nexa-danger-strong)" }}>
            {createError}
          </p>
        ) : null}
        <p className="mt-3 text-[11px] leading-relaxed nexa-muted">
          NEXA stores only a hash. The key itself is shown once and cannot be
          recovered later.
        </p>
      </Dialog>

      <Dialog
        open={reveal !== null}
        onClose={dismissReveal}
        title="Copy your API key now"
        description="This key is shown once. Store it securely. NEXA cannot recover it after you leave this screen."
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={dismissReveal}>
              Done
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Copy className="size-3.5" aria-hidden />}
              onClick={() => void copyKey()}
            >
              {copied ? "Copied" : "Copy key"}
            </Button>
          </>
        }
      >
        <p className="mb-2 text-[11px] nexa-muted">{reveal?.name}</p>
        <label htmlFor="api-key-plaintext" className="sr-only">
          New API key
        </label>
        <input
          id="api-key-plaintext"
          readOnly
          value={reveal?.plaintext ?? ""}
          onFocus={(e) => e.currentTarget.select()}
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-control border bg-transparent px-3 py-2 font-mono text-xs nexa-text outline-none"
          style={{ borderColor: "var(--nexa-border)" }}
        />
        <p role="status" aria-live="polite" className="mt-2 text-[11px] nexa-muted">
          {copied ? "Copied to clipboard." : "Use the copy button, or select the text above."}
        </p>
      </Dialog>

      <ConfirmDialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => void revoke()}
        title={`Revoke "${revokeTarget?.name ?? ""}"?`}
        description="Any client using this key will immediately receive HTTP 401. The key cannot be reactivated; create a new one instead."
        confirmLabel="Revoke key"
        tone="danger"
        busy={revoking}
      />
    </div>
  );
}
