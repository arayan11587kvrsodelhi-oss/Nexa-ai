"use client";
import { useCallback, useState } from "react";
export interface ModelsProbe {
  provider?: string; modelName?: string;
  reachable?: boolean; message?: string; isDemo?: boolean;
}
export function useModelsProbe() {
  const [probe, setProbe] = useState<ModelsProbe | null>(null);
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/models", { cache: "no-store" });
      if (!res.ok) return;
      const d = (await res.json()) as {
        activeConfig?: { provider?: string; modelName?: string; isDemo?: boolean };
        reachability?: { ok?: boolean; message?: string };
      };
      setProbe({
        provider: d.activeConfig?.provider, modelName: d.activeConfig?.modelName,
        reachable: d.reachability?.ok, message: d.reachability?.message,
        isDemo: d.activeConfig?.isDemo,
      });
    } catch { /* header degrades silently */ }
  }, []);
  return { probe, refresh };
}
