import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { LocalEngineStatus } from "@/components/shell/local-engine-status";
import { RequireAuth } from "@/components/auth/require-auth";
import { FilesPanel } from "@/components/files/files-panel";

export const metadata: Metadata = { title: "Files" };
export const dynamic = "force-dynamic";

export default function FilesPage() {
  return (
    <AppShell title="Files" actions={<LocalEngineStatus />}>
      <RequireAuth>
        <div className="h-full overflow-y-auto">
          <FilesPanel />
        </div>
      </RequireAuth>
    </AppShell>
  );
}
