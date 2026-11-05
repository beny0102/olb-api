import pg from "pg";

/** DI token for the single process-wide Postgres pool. */
export const PG_POOL = Symbol("PG_POOL");

/**
 * Creates the shared pool. The API opens one pool and hands it to every
 * Postgres-backed store so a request never creates its own connections.
 */
export function createPool(url: string): pg.Pool {
  return new pg.Pool({
    connectionString: url,
    max: 10,
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
  });
}
