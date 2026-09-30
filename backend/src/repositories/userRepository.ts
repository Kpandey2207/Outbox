import { pool, type Queryable } from '../db/pool.js';
import type { User } from '../models/types.js';

export interface UpsertUserInput {
  googleId: string | null;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export const userRepository = {
  async findById(id: string, db: Queryable = pool): Promise<User | null> {
    const { rows } = await db.query<User>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ?? null;
  },

  async findByEmail(email: string, db: Queryable = pool): Promise<User | null> {
    const { rows } = await db.query<User>('SELECT * FROM users WHERE email = lower($1)', [email]);
    return rows[0] ?? null;
  },

  /** Creates an email + password account; returns null if the email is already taken. */
  async createWithPassword(email: string, passwordHash: string, db: Queryable = pool): Promise<User | null> {
    const { rows } = await db.query<User>(
      `INSERT INTO users (email, name, password_hash) VALUES (lower($1), split_part($1, '@', 1), $2)
       ON CONFLICT (email) DO NOTHING RETURNING *`,
      [email, passwordHash],
    );
    return rows[0] ?? null;
  },

  async clearPassword(id: string, db: Queryable = pool): Promise<void> {
    await db.query('UPDATE users SET password_hash = NULL, updated_at = now() WHERE id = $1', [id]);
  },

  /** Inserts or refreshes the profile keyed by email, the identity Google guarantees. */
  async upsert(input: UpsertUserInput, db: Queryable = pool): Promise<User> {
    const { rows } = await db.query<User>(
      `INSERT INTO users (google_id, email, name, avatar_url)
       VALUES ($1, lower($2), $3, $4)
       ON CONFLICT (email) DO UPDATE SET
         google_id  = COALESCE(EXCLUDED.google_id, users.google_id),
         name       = COALESCE(EXCLUDED.name, users.name),
         avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
         updated_at = now()
       RETURNING *`,
      [input.googleId, input.email, input.name, input.avatarUrl],
    );
    return rows[0]!;
  },
};
