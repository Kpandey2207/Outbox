import { pool, type Queryable } from '../db/pool.js';
import type { SlackInstallation } from '../models/types.js';
import { openSecret, sealSecret } from '../utils/secretBox.js';

export const slackRepository = {
  async findByUser(userId: string, db: Queryable = pool): Promise<SlackInstallation | null> {
    const { rows } = await db.query<SlackInstallation>(
      'SELECT * FROM slack_installations WHERE user_id = $1',
      [userId],
    );
    const row = rows[0];
    return row
      ? { ...row, bot_token: openSecret(row.bot_token), webhook_url: row.webhook_url ? openSecret(row.webhook_url) : null }
      : null;
  },

  async upsert(install: Omit<SlackInstallation, 'installed_at'>, db: Queryable = pool): Promise<void> {
    await db.query(
      `INSERT INTO slack_installations (user_id, team_id, team_name, bot_token, channel_id, channel_name, webhook_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET
         team_id = EXCLUDED.team_id, team_name = EXCLUDED.team_name, bot_token = EXCLUDED.bot_token,
         channel_id = EXCLUDED.channel_id, channel_name = EXCLUDED.channel_name,
         webhook_url = EXCLUDED.webhook_url, installed_at = now()`,
      [
        install.user_id,
        install.team_id,
        install.team_name,
        sealSecret(install.bot_token),
        install.channel_id,
        install.channel_name,
        install.webhook_url ? sealSecret(install.webhook_url) : null,
      ],
    );
  },

  /** Deletes the installation and returns its token so the caller can revoke it at Slack. */
  async remove(userId: string, db: Queryable = pool): Promise<string | null> {
    const { rows } = await db.query<{ bot_token: string }>(
      'DELETE FROM slack_installations WHERE user_id = $1 RETURNING bot_token',
      [userId],
    );
    return rows[0] ? openSecret(rows[0].bot_token) : null;
  },
};
