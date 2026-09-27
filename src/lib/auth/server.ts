import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SessionService, type SessionUser } from "./session";

/** Server-side session lookup for App Router pages/layouts. Never throws. */
export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const store = await cookies();
    const token = store.get("nexa_session")?.value;
    if (!token) return null;
    return await SessionService.getUserByToken(token);
  } catch {
    return null;
  }
}

/** Require auth in a server page; redirects to /login?next=<path> when missing. */
export async function requireSessionUser(nextPath: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return user;
}
