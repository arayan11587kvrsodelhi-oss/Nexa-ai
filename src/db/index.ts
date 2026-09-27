import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/**
 * Database access.
 *
 * The client is created lazily. A missing or malformed DATABASE_URL must
 * surface as the user-facing "Database connection unavailable." state, not as
 * a module-load crash that takes down the whole server (and breaks `next build`,
 * which imports every route to collect page data).
 */

export type Database = NodePgDatabase<Record<string, never>>;

const globalForDb = globalThis as typeof globalThis & {
  __nexaPool?: Pool;
  __nexaDb?: Database;
  __nexaDbError?: string | null;
};

export interface DatabaseStatus {
  configured: boolean;
  /** True only after a successful `select 1`. */
  reachable: boolean;
  message: string;
}

function readDatabaseUrl(): string | null {
  const url = process.env.DATABASE_URL?.trim();
  return url && url.length > 0 ? url : null;
}

export function getPool(): Pool | null {
  const url = readDatabaseUrl();
  if (!url) {
    globalForDb.__nexaDbError =
      "Database connection unavailable. DATABASE_URL is not set.";
    return null;
  }

  if (!globalForDb.__nexaPool) {
    globalForDb.__nexaPool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return globalForDb.__nexaPool;
}

export function getDb(): Database | null {
  if (globalForDb.__nexaDb) return globalForDb.__nexaDb;
  const pool = getPool();
  if (!pool) return null;
  globalForDb.__nexaDb = drizzle(pool);
  return globalForDb.__nexaDb;
}

/**
 * Proxy that defers pool creation to first property access.
 * Every existing `db.select()...` call site keeps working unchanged, while a
 * missing DATABASE_URL now throws a controlled error inside the request
 * instead of at import time.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, prop, receiver) {
    const instance = getDb();
    if (!instance) {
      throw new Error(
        "Database connection unavailable. Set DATABASE_URL to a reachable PostgreSQL instance."
      );
    }
    return Reflect.get(instance as object, prop, receiver);
  },
});

/** Cheap liveness probe used by /api/health and every failure-state renderer. */
export async function checkDatabase(): Promise<DatabaseStatus> {
  const pool = getPool();
  if (!pool) {
    return {
      configured: false,
      reachable: false,
      message: "Database connection unavailable. DATABASE_URL is not set.",
    };
  }

  try {
    const client = await pool.connect();
    try {
      await client.query("select 1");
    } finally {
      client.release();
    }
    globalForDb.__nexaDbError = null;
    return { configured: true, reachable: true, message: "Connected." };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown connection error";
    globalForDb.__nexaDbError = message;
    return {
      configured: true,
      reachable: false,
      message:
        "Database connection unavailable. PostgreSQL did not accept the connection.",
    };
  }
}

/** Last observed connection error, for the technical-detail disclosure. */
export function getLastDatabaseError(): string | null {
  return globalForDb.__nexaDbError ?? null;
}
