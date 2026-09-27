import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { LocalEngineStatus } from "@/components/shell/local-engine-status";
import { RequireAuth } from "@/components/auth/require-auth";
import { PlaygroundPanel } from "@/components/playground/playground-panel";

export const metadata: Metadata = { title: "Playground" };
export const dynamic = "force-dynamic";

export default function PlaygroundPage() {
  return (
    <AppShell title="Playground" actions={<LocalEngineStatus />}>
      <RequireAuth>
        <div className="h-full overflow-y-auto">
          <PlaygroundPanel />
        </div>
      </RequireAuth>
    </AppShell>
  );
}
