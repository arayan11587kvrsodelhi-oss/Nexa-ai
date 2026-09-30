import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { LocalEngineStatus } from "@/components/shell/local-engine-status";
import { RequireAuth } from "@/components/auth/require-auth";
import { ApiKeysPanel } from "@/components/settings/api-keys-panel";

export const metadata: Metadata = { title: "API keys" };
export const dynamic = "force-dynamic";

export default function SettingsApiKeysPage() {
  return (
    <AppShell title="Settings · API keys" actions={<LocalEngineStatus />}>
      <RequireAuth>
        <div className="h-full overflow-y-auto">
          <ApiKeysPanel />
        </div>
      </RequireAuth>
    </AppShell>
  );
}
