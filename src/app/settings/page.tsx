import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { RequireAuth } from "@/components/auth/require-auth";
import { SettingsPanel } from "@/components/settings/settings-panel";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <AppShell title="Settings">
      <RequireAuth>
        <div className="h-full overflow-y-auto">
          <SettingsPanel />
        </div>
      </RequireAuth>
    </AppShell>
  );
}
