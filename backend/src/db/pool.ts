import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { safeError } from '../utils/errors.js';

// Return BIGINT/COUNT(*) as numbers; our counts never approach 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

/**
 * Timeouts so a hung connection or query fails (and is retried) instead of holding a job,
 * and with it a worker slot and graceful shutdown, forever.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 30_000,
  query_timeout: 35_000,
});

pool.on('error', (err) => logger.error({ err: safeError(err) }, 'postgres pool error'));

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Serialises transactions that use the same key; released at COMMIT or ROLLBACK. */
export async function advisoryXactLock(client: pg.PoolClient, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
}
