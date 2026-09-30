"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Database,
  FileText,
  HardDrive,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback";
import { cn } from "@/lib/utils";

interface HealthPayload {
  ok: boolean;
  database: { configured: boolean; reachable: boolean; message: string };
  engine: { provider: string };
}

interface ModelsPayload {
  activeConfig?: {
    provider?: string;
    modelName?: string;
    baseUrl?: string;
    isDemo?: boolean;
  };
  reachability?: { ok?: boolean; message?: string; models?: string[]; latencyMs?: number };
  /** Models reported by the provider's own discovery endpoint. */
  discoveredModels?: Array<{ id: string; name: string; contextWindow: number | null }>;
}

const PROVIDER_LABELS: Record<string, string> = {
  ollama: "Ollama",
  openai_compatible: "an OpenAI-compatible endpoint",
  vllm: "vLLM",
  freellmapi: "FreeLLMAPI",
  demo: "the demo sandbox",
  custom: "a custom provider",
};

function providerLabel(provider?: string): string {
  if (!provider) return "an unknown provider";
  return PROVIDER_LABELS[provider] ?? provider;
}

type Probe<T> =
  | { state: "loading" }
  | { state: "error"; message: string; detail?: string }
  | { state: "ready"; value: T };

const CAPABILITIES = [
  { icon: FileText, label: "Documents", href: "/files" },
  { icon: Search, label: "Web search", href: "/settings" },
  { icon: Sparkles, label: "Memory", href: "/settings/memory" },
];

/**
 * The workspace landing / diagnostics panel.
 *
 * Every line here is a reading, not a promise: it states what the server
 * actually observed. When something is missing it says so plainly and points at
 * the fix, instead of silently degrading.
 */
export function WorkspaceOverview() {
  const [health, setHealth] = useState<Probe<HealthPayload>>({ state: "loading" });
  const [models, setModels] = useState<Probe<ModelsPayload>>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;

    const probe = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = (await res.json()) as HealthPayload;
        if (!cancelled) setHealth({ state: "ready", value: data });
      } catch (err) {
        if (!cancelled)
          setHealth({
            state: "error",
            message: "Unable to reach the server.",
            detail: err instanceof Error ? err.message : String(err),
          });
      }

      try {
        const res = await fetch("/api/models", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ModelsPayload;
        if (!cancelled) setModels({ state: "ready", value: data });
      } catch (err) {
        if (!cancelled)
          setModels({
            state: "error",
            message: "Unable to read model configuration.",
            detail: err instanceof Error ? err.message : String(err),
          });
      }
    };

    void probe();
    return () => {
      cancelled = true;
    };
  }, []);

  const dbReachable =
    health.state === "ready" ? health.value.database.reachable : null;
  const engineOk = models.state === "ready" ? Boolean(models.value.reachability?.ok) : null;
  const isDemo = models.state === "ready" ? Boolean(models.value.activeConfig?.isDemo) : false;
  const activeProviderId =
    models.state === "ready" ? models.value.activeConfig?.provider : undefined;
  const isExternalProvider = activeProviderId === "freellmapi";
  const reportedModelCount =
    models.state === "ready"
      ? models.value.discoveredModels?.length ?? models.value.reachability?.models?.length ?? 0
      : 0;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-10">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight nexa-text">
          NEXA AI
        </h1>
        <p className="text-sm nexa-muted">
          Your Private AI Workspace. Everything below reflects what this
          installation can actually do right now.
        </p>
      </header>

      {/* ---- Database ---- */}
      {health.state === "error" ? (
        <ErrorState
          title="Database connection unavailable."
          message={health.message}
          detail={health.detail}
        />
      ) : (
        <SetupRow
          icon={Database}
          label="Database"
          status={
            health.state === "loading"
              ? "checking"
              : dbReachable
                ? "ok"
                : "down"
          }
          detail={
            health.state === "loading"
              ? "Checking PostgreSQL…"
              : health.value.database.message
          }
          action={
            health.state === "ready" && !dbReachable ? (
              <code className="rounded border border-graphite-750 bg-obsidian-900 px-1.5 py-0.5 font-mono text-[11px] text-ink-400">
                DATABASE_URL
              </code>
            ) : null
          }
        />
      )}

      {/* ---- Inference engine ---- */}
      {models.state === "error" ? (
        <ErrorState
          title="Model configuration unavailable."
          message={models.message}
          detail={models.detail}
        />
      ) : models.state === "loading" ? (
        <SetupRow icon={HardDrive} label="Local AI engine" status="checking" detail="Probing provider…" />
      ) : isDemo ? (
        <ErrorState
          tone="warning"
          title="Demo mode is active."
          message="Responses come from the simulated sandbox engine and are not produced by a real model. Turn this off in Model settings to use real inference."
          action={
            <Link href="/settings/models">
              <Button size="sm" variant="secondary" icon={<ArrowRight className="size-3.5" aria-hidden />}>
                Open model settings
              </Button>
            </Link>
          }
        />
      ) : engineOk ? (
        <SetupRow
          icon={HardDrive}
          label={isExternalProvider ? "Inference engine (external provider)" : "Local AI engine"}
          status="ok"
          detail={
            <>
              <span className="font-mono text-teal-400">
                {models.value.activeConfig?.modelName || "model not reported"}
              </span>{" "}
              via {providerLabel(models.value.activeConfig?.provider)}
              {models.value.reachability?.latencyMs !== undefined
                ? ` · ${models.value.reachability.latencyMs} ms`
                : ""}
              {reportedModelCount > 0
                ? ` · ${reportedModelCount} models ${
                    isExternalProvider ? "reported by the provider" : "installed"
                  }`
                : ""}
            </>
          }
        />
      ) : (
        <ErrorState
          title={`${providerLabel(activeProviderId)} is unavailable.`}
          message={
            models.value.reachability?.message ||
            `No inference provider is reachable at ${models.value.activeConfig?.baseUrl ?? "the configured endpoint"}.`
          }
          action={
            <Link href="/settings/models">
              <Button size="sm" variant="secondary" icon={<ArrowRight className="size-3.5" aria-hidden />}>
                Configure model
              </Button>
            </Link>
          }
        />
      )}

      {isExternalProvider && engineOk ? (
        <ErrorState
          tone="warning"
          title="External provider active."
          message="Prompts — and any retrieved document excerpts sent with them — leave this host and are handled by the configured FreeLLMAPI installation and its provider pool. Model availability and capacity are controlled by that provider and can change at any time; NEXA does not guarantee a specific model list, quota, or monthly token allowance."
        />
      ) : null}

      <div className="nexa-overlay rounded-panel border border-graphite-800 p-4" style={{ borderColor: "var(--nexa-border)" }}>
        <p className="text-xs font-medium uppercase tracking-wider nexa-muted">
          What you can do once a model is connected
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {CAPABILITIES.map(({ icon: Icon, label, href }) => (
            <Link
              key={label}
              href={href}
              className="group flex items-center gap-2 rounded-control border px-3 py-2.5 text-xs nexa-text nexa-hoverable"
              style={{ borderColor: "var(--nexa-border)" }}
            >
              <Icon className="size-3.5 nexa-muted group-hover:text-teal-400" aria-hidden />
              {label}
              <ArrowRight className="ml-auto size-3 nexa-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
          ))}
        </div>
      </div>

      <div className="flex items-start gap-2.5 rounded-panel border px-4 py-3" style={{ borderColor: "var(--nexa-border)" }}>
        <ShieldCheck className="mt-0.5 size-4 shrink-0 nexa-accent-text" aria-hidden />
        <p className="text-[11px] leading-relaxed nexa-muted">
          NEXA AI runs entirely on your machine. Prompts, documents, embeddings
          and conversation history stay in your own PostgreSQL database, and no
          request leaves this host unless you explicitly enable an external
          provider or web search.
        </p>
      </div>
    </div>
  );
}

function SetupRow({
  icon: Icon,
  label,
  status,
  detail,
  action,
}: {
  icon: typeof Database;
  label: string;
  status: "ok" | "down" | "checking";
  detail: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-panel border px-4 py-3",
        status === "down" ? "nexa-wash-danger" : "nexa-overlay"
      )}
      style={status === "down" ? undefined : { borderColor: "var(--nexa-border)" }}
    >
      <Icon
        className={cn("size-4 shrink-0", status === "down" ? "" : "nexa-muted")}
        style={status === "down" ? { color: "var(--nexa-danger-wash-line)" } : undefined}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium nexa-text">{label}</span>
          {status === "checking" ? (
            <Badge tone="muted">checking</Badge>
          ) : status === "ok" ? (
            <Badge tone="accent">
              <StatusDot tone="success" />
              ready
            </Badge>
          ) : (
            <Badge tone="danger">
              <StatusDot tone="danger" />
              unavailable
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] nexa-muted">{detail}</p>
      </div>
      {action}
    </div>
  );
}