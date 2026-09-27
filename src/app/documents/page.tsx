import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /documents is the user-facing alias for the canonical /files route,
 * which is backed by /api/files. No duplicate storage logic.
 */
export default function DocumentsRedirect() {
  redirect("/files");
}
