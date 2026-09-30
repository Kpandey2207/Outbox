import { pool, type Queryable } from '../db/pool.js';
import type { PublicSender, Sender } from '../models/types.js';
import { openSecret, sealSecret } from '../utils/secretBox.js';

const withSecret = (row: Sender | undefined): Sender | null => (row ? { ...row, smtp_pass: openSecret(row.smtp_pass) } : null);

const PUBLIC_COLUMNS = 'id, user_id, email, display_name, created_at';

export const senderRepository = {
  async findById(id: string, db: Queryable = pool): Promise<Sender | null> {
    const { rows } = await db.query<Sender>('SELECT * FROM senders WHERE id = $1', [id]);
    return withSecret(rows[0]);
  },

  async findForUser(userId: string, senderId: string, db: Queryable = pool): Promise<Sender | null> {
    const { rows } = await db.query<Sender>('SELECT * FROM senders WHERE id = $1 AND user_id = $2', [
      senderId,
      userId,
    ]);
    return withSecret(rows[0]);
  },

  async listForUser(userId: string, db: Queryable = pool): Promise<PublicSender[]> {
    const { rows } = await db.query<PublicSender>(
      `SELECT ${PUBLIC_COLUMNS} FROM senders WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return rows;
  },

  async create(
    input: { userId: string; email: string; displayName: string | null; smtpUser: string; smtpPass: string },
    db: Queryable = pool,
  ): Promise<PublicSender> {
    const { rows } = await db.query<PublicSender>(
      `INSERT INTO senders (user_id, email, display_name, smtp_user, smtp_pass)
       VALUES ($1, lower($2), $3, $4, $5)
       ON CONFLICT (user_id, email) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING ${PUBLIC_COLUMNS}`,
      [input.userId, input.email, input.displayName, input.smtpUser, sealSecret(input.smtpPass)],
    );
    return rows[0]!;
  },
};
