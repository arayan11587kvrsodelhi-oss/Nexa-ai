import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { RequireAuth } from "@/components/auth/require-auth";
import { MemoryPanel } from "@/components/settings/memory-panel";

export const metadata: Metadata = { title: "Memory settings" };
export const dynamic = "force-dynamic";

export default function SettingsMemoryPage() {
  return (
    <AppShell title="Settings · Memory">
      <RequireAuth>
        <div className="h-full overflow-y-auto">
          <MemoryPanel />
        </div>
      </RequireAuth>
    </AppShell>
  );
}
