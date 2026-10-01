import { checkDatabase } from "@/db";
import { resolveProviderType } from "@/lib/ai/providers/factory";

export const dynamic = "force-dynamic";

/**
 * Phase 5.7 — internal-topology disclosure.
 *
 * This route is intentionally unauthenticated: it is the liveness probe a load
 * balancer or uptime monitor calls. That is exactly why it must not describe
 * the network it sits on.
 *
 * It used to return `engine.baseUrl`, i.e. the operator's provider endpoint —
 * `http://10.0.0.5:31415/v1`, an internal host, IP and port. Any anonymous
 * caller could read the deployment's internal service topology, which is
 * reconnaissance for lateral movement and for tuning an SSRF payload. No
 * caller needed it: the diagnostics panel renders engine state from
 * `/api/models`, which is session-authenticated, and nothing consumed
 * `engine.baseUrl` at all.
 *
 * The coarse `provider` name is kept — it is a fingerprint, not a location,
 * and it is what makes this endpoint useful for diagnostics. The endpoint
 * itself is not returned.
 *
 * The provider identity is resolved through the shared
 * `resolveProviderType()` so this probe can never name a different default than
 * the one inference actually uses.
 */
function getEngineConfig() {
  const provider = resolveProviderType(process.env.DEFAULT_PROVIDER);
  return { provider };
}

/**
 * Liveness probe.
 *
 * Reports database state honestly and returns 200 when the app itself is
 * serving. The database section carries its own `reachable` flag so a monitor
 * can distinguish "process up, database down" from "process down".
 *
 * The engine section names the provider the running Next.js process is
 * configured to use. It deliberately reports no endpoint: this route is
 * unauthenticated, so the provider's host, IP and port are not published
 * here. It also does not claim that an upstream model is reachable or that
 * inference is working.
 */
export async function GET() {
  const database = await checkDatabase();
  const engine = getEngineConfig();

  return Response.json({
    ok: true,
    app: "nexa-ai",
    version: "1.0.0",
    database: {
      configured: database.configured,
      reachable: database.reachable,
      message: database.message,
    },
    engine,
  });
}

/** Cheap readiness variant for monitors: 503 while the database is down. */
export async function HEAD() {
  const database = await checkDatabase();

  return new Response(null, {
    status: database.reachable ? 200 : 503,
    headers: {
      "x-nexa-db": database.reachable ? "up" : "down",
    },
  });
}