import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { LocalEngineStatus } from "@/components/shell/local-engine-status";
import { RequireAuth } from "@/components/auth/require-auth";
import { ModelsPanel } from "@/components/models/models-panel";

export const metadata: Metadata = { title: "Model settings" };
export const dynamic = "force-dynamic";

export default function SettingsModelsPage() {
  return (
    <AppShell title="Settings · Models" actions={<LocalEngineStatus />}>
      <RequireAuth>
        <div className="h-full overflow-y-auto">
          <ModelsPanel />
        </div>
      </RequireAuth>
    </AppShell>
  );
}
