import { AppShell } from "@/components/shell/app-shell";
import { LocalEngineStatus } from "@/components/shell/local-engine-status";
import { WorkspaceOverview } from "@/components/chat/workspace-overview";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <AppShell title="Chats" actions={<LocalEngineStatus />}>
      <div className="h-full overflow-y-auto">
        <WorkspaceOverview />
      </div>
    </AppShell>
  );
}
