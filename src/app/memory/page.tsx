import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { LocalEngineStatus } from "@/components/shell/local-engine-status";
import { RequireAuth } from "@/components/auth/require-auth";
import { MemoryPanel } from "@/components/settings/memory-panel";

export const metadata: Metadata = { title: "Memory" };
export const dynamic = "force-dynamic";

/**
 * Memory is a first-class workspace area in Phase 6, so it gets its own route
 * and nav entry.
 *
 * The panel is *not* duplicated: `/settings/memory` and `/memory` render the
 * same `MemoryPanel`, so there is one implementation reading `/api/memory`
 * rather than two that can drift apart.
 */
export default function MemoryPage() {
  return (
    <AppShell title="Memory" actions={<LocalEngineStatus />}>
      <RequireAuth>
        <div className="h-full overflow-y-auto">
          <MemoryPanel />
        </div>
      </RequireAuth>
    </AppShell>
  );
}
