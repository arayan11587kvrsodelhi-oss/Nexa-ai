"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Cpu } from "lucide-react";
import { Badge, StatusDot } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface EngineStatus {
  reachable: boolean;
  provider: string;
  model: string;
  message: string;
  isDemo: boolean;
}

/**
 * Provider identity as shown in the header badge.
 *
 * The badge always names both the provider and the model, so an external
 * provider is never presented as if it were the local engine.
 */
const PROVIDER_LABELS: Record<string, string> = {
  ollama: "Ollama",
  openai_compatible: "OpenAI-compatible",
  vllm: "vLLM",
  freellmapi: "FreeLLMAPI",
  demo: "Demo sandbox",
  custom: "Custom provider",
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * Header indicator for the active inference engine.
 *
 * This is a truthful readout: it reports exactly what GET /api/models
 * observed. It never shows "connected" optimistically, and it labels demo
 * mode explicitly whenever the active provider is the simulated sandbox.
 */
export function LocalEngineStatus() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        const res = await fetch("/api/models", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as {
          activeConfig?: { provider?: string; modelName?: string; isDemo?: boolean };
          reachability?: { ok?: boolean; message?: string };
        };
        if (cancelled) return;
        setStatus({
          reachable: Boolean(data.reachability?.ok),
          provider: data.activeConfig?.provider ?? "unknown",
          model: data.activeConfig?.modelName ?? "unknown",
          message: data.reachability?.message ?? "",
          isDemo: Boolean(data.activeConfig?.isDemo),
        });
        setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };

    void run();
    const onRefresh = () => void run();
    window.addEventListener("nexa:engine-changed", onRefresh);
    const interval = setInterval(onRefresh, 30_000);
    return () => {
      cancelled = true;
      window.removeEventListener("nexa:engine-changed", onRefresh);
      clearInterval(interval);
    };
  }, []);

  if (failed) {
    return (
      <Badge tone="danger">
        <StatusDot tone="danger" />
        Engine status unknown
      </Badge>
    );
  }

  if (!status) {
    return (
      <span className="nexa-skeleton h-5 w-28 rounded-full" aria-hidden />
    );
  }

  if (status.isDemo) {
    return (
      <Link href="/settings/models" title={status.message}>
        <Badge tone="warning">
          <Cpu className="size-3" aria-hidden />
          DEMO MODE
        </Badge>
      </Link>
    );
  }

  return (
    <Link
      href="/settings/models"
      title={`${providerLabel(status.provider)} — ${status.message || "no status reported"}`}
      className="group"
    >
      <Badge
        tone={status.reachable ? "accent" : "danger"}
        className={cn("max-w-56", !status.reachable && "border-danger-500/40")}
      >
        <StatusDot tone={status.reachable ? "success" : "danger"} />
        <span className="truncate font-mono">
          {status.reachable
            ? `${providerLabel(status.provider)} · ${status.model || "model not reported"}`
            : `${providerLabel(status.provider)} offline`}
        </span>
      </Badge>
    </Link>
  );
}