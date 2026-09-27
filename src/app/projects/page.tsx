import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { LocalEngineStatus } from "@/components/shell/local-engine-status";
import { RequireAuth } from "@/components/auth/require-auth";
import { ProjectsPanel } from "@/components/projects/projects-panel";

export const metadata: Metadata = { title: "Projects" };
export const dynamic = "force-dynamic";

export default function ProjectsPage() {
  return (
    <AppShell title="Projects" actions={<LocalEngineStatus />}>
      <RequireAuth>
        <div className="h-full overflow-y-auto">
          <ProjectsPanel />
        </div>
      </RequireAuth>
    </AppShell>
  );
}
