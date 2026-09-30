import type pg from 'pg';
import { pool, type Queryable } from '../db/pool.js';
import type { Attachment, AttachmentMeta } from '../models/types.js';

const META = 'id, campaign_id, filename, content_type, size_bytes, created_at';

export const attachmentRepository = {
  async create(
    input: { userId: string; filename: string; contentType: string; data: Buffer },
    db: Queryable = pool,
  ): Promise<AttachmentMeta> {
    const { rows } = await db.query<AttachmentMeta>(
      // clock_timestamp, not now(): files uploaded together share a transaction, and their
      // order in the email follows created_at.
      `INSERT INTO attachments (user_id, filename, content_type, size_bytes, data, created_at)
       VALUES ($1, $2, $3, $4, $5, clock_timestamp()) RETURNING ${META}`,
      [input.userId, input.filename, input.contentType, input.data.length, input.data],
    );
    return rows[0]!;
  },

  async findForUser(userId: string, id: string, db: Queryable = pool): Promise<Attachment | null> {
    const { rows } = await db.query<Attachment>('SELECT * FROM attachments WHERE id = $1 AND user_id = $2', [id, userId]);
    return rows[0] ?? null;
  },

  /**
   * Links the user's not-yet-used uploads to a campaign, inside the campaign's transaction.
   * Returns the linked rows; fewer than asked means some ids were foreign, used or missing.
   */
  async linkToCampaign(client: pg.PoolClient, userId: string, campaignId: string, ids: string[]): Promise<AttachmentMeta[]> {
    if (ids.length === 0) return [];
    const { rows } = await client.query<AttachmentMeta>(
      `UPDATE attachments SET campaign_id = $3
       WHERE user_id = $1 AND id = ANY($2::uuid[]) AND campaign_id IS NULL
       RETURNING ${META}`,
      [userId, ids, campaignId],
    );
    return rows;
  },

  async listMetaByCampaign(campaignId: string, db: Queryable = pool): Promise<AttachmentMeta[]> {
    const { rows } = await db.query<AttachmentMeta>(
      `SELECT ${META} FROM attachments WHERE campaign_id = $1 ORDER BY created_at, id`,
      [campaignId],
    );
    return rows;
  },

  async listWithDataByCampaign(campaignId: string, db: Queryable = pool): Promise<Attachment[]> {
    const { rows } = await db.query<Attachment>(
      'SELECT * FROM attachments WHERE campaign_id = $1 ORDER BY created_at, id',
      [campaignId],
    );
    return rows;
  },

  /** Removes an upload the user changed their mind about. Linked files are kept. */
  async deleteUnlinked(userId: string, id: string, db: Queryable = pool): Promise<boolean> {
    const { rowCount } = await db.query(
      'DELETE FROM attachments WHERE id = $1 AND user_id = $2 AND campaign_id IS NULL',
      [id, userId],
    );
    return rowCount === 1;
  },

  async countUnlinked(userId: string, db: Queryable = pool): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM attachments WHERE user_id = $1 AND campaign_id IS NULL',
      [userId],
    );
    return rows[0]?.n ?? 0;
  },

  async deleteAllUnlinked(userId: string, db: Queryable = pool): Promise<void> {
    await db.query('DELETE FROM attachments WHERE user_id = $1 AND campaign_id IS NULL', [userId]);
  },

  /** Uploads never scheduled within a day are abandoned drafts. Cleaned up on the next upload. */
  async deleteStaleUnlinked(userId: string, db: Queryable = pool): Promise<number> {
    const { rowCount } = await db.query(
      `DELETE FROM attachments WHERE user_id = $1 AND campaign_id IS NULL AND created_at < now() - interval '1 day'`,
      [userId],
    );
    return rowCount ?? 0;
  },
};
