import { checkDatabase } from "@/db";

export const dynamic = "force-dynamic";

function getEngineConfig() {
  const provider = (
    process.env.DEFAULT_PROVIDER ?? "ollama"
  ).trim().toLowerCase();

  switch (provider) {
    case "freellmapi":
      return {
        provider: "freellmapi",
        baseUrl:
          process.env.FREELLMAPI_BASE_URL ??
          "http://127.0.0.1:31415/v1",
      };

    case "ollama":
    default:
      return {
        provider,
        baseUrl:
          process.env.OLLAMA_BASE_URL ??
          "http://localhost:11434",
      };
  }
}

/**
 * Liveness probe.
 *
 * Reports database state honestly and returns 200 when the app itself is
 * serving. The database section carries its own `reachable` flag so a monitor
 * can distinguish "process up, database down" from "process down".
 *
 * The engine section reports the provider configuration actually visible to
 * the running Next.js process. It does not claim that an upstream model is
 * reachable or inference is working.
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