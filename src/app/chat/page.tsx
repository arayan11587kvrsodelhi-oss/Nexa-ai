import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { LocalEngineStatus } from "@/components/shell/local-engine-status";
import { RequireAuth } from "@/components/auth/require-auth";
import { ChatWorkspace } from "@/components/chat/chat-workspace";

export const metadata: Metadata = { title: "Chat" };
export const dynamic = "force-dynamic";

export default function ChatPage() {
  return (
    <AppShell title="Chat" actions={<LocalEngineStatus />}>
      <RequireAuth next="/chat">
        <ChatWorkspaceShell />
      </RequireAuth>
    </AppShell>
  );
}

function ChatWorkspaceShell() {
  return <ChatWorkspace />;
}