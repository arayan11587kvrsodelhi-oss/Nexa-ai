import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { LocalEngineStatus } from "@/components/shell/local-engine-status";
import { RequireAuth } from "@/components/auth/require-auth";
import { SearchPanel } from "@/components/search/search-panel";

export const metadata: Metadata = { title: "Search" };
export const dynamic = "force-dynamic";

export default function SearchPage() {
  return (
    <AppShell title="Search" actions={<LocalEngineStatus />}>
      <RequireAuth>
        <div className="h-full overflow-y-auto">
          <SearchPanel />
        </div>
      </RequireAuth>
    </AppShell>
  );
}
