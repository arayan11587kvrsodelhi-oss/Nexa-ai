import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { LocalEngineStatus } from "@/components/shell/local-engine-status";
import { RequireAuth } from "@/components/auth/require-auth";
import { AgentsPanel } from "@/components/agents/agents-panel";

export const metadata: Metadata = { title: "Agents" };
export const dynamic = "force-dynamic";

export default function AgentsPage() {
  return (
    <AppShell title="Agents" actions={<LocalEngineStatus />}>
      <RequireAuth>
        <div className="h-full overflow-y-auto">
          <AgentsPanel />
        </div>
      </RequireAuth>
    </AppShell>
  );
}
