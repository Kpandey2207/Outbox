import { pool, type Queryable } from '../db/pool.js';
import type { User } from '../models/types.js';

export const sessionRepository = {
  async create(userId: string, tokenHash: Buffer, ttlHours: number, db: Queryable = pool): Promise<void> {
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3::int * interval '1 hour'))`,
      [userId, tokenHash, ttlHours],
    );
    // Housekeeping: a user's dead sessions go when they next sign in.
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND (expires_at < now() OR revoked_at IS NOT NULL)', [userId]);
  },

  async findUser(tokenHash: Buffer, db: Queryable = pool): Promise<User | null> {
    const { rows } = await db.query<User>(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [tokenHash],
    );
    return rows[0] ?? null;
  },

  async revoke(tokenHash: Buffer, db: Queryable = pool): Promise<void> {
    await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash]);
  },

  async revokeAllForUser(userId: string, db: Queryable = pool): Promise<void> {
    await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  },
};
