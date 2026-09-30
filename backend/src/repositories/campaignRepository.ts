import type pg from 'pg';
import { pool, type Queryable } from '../db/pool.js';
import type { Campaign, Email } from '../models/types.js';

export interface NewCampaign {
  userId: string;
  senderId: string;
  subject: string;
  body: string;
  startAt: Date;
  delayBetweenMs: number;
  hourlyLimit: number;
  idempotencyKey: string | null;
  requestHash: Buffer | null;
}

export interface PlannedEmail {
  recipient: string;
  scheduledAt: Date;
}

export const campaignRepository = {
  async findByIdempotencyKey(userId: string, key: string, db: Queryable = pool): Promise<Campaign | null> {
    const { rows } = await db.query<Campaign>(
      'SELECT * FROM campaigns WHERE user_id = $1 AND idempotency_key = $2',
      [userId, key],
    );
    return rows[0] ?? null;
  },

  async scheduleBounds(campaignId: string, db: Queryable = pool): Promise<{ first: Date; last: Date }> {
    const { rows } = await db.query<{ first: Date; last: Date }>(
      'SELECT min(scheduled_at) AS first, max(scheduled_at) AS last FROM emails WHERE campaign_id = $1',
      [campaignId],
    );
    return rows[0]!;
  },

  /**
   * Inserts the campaign and all of its emails. Must run inside a transaction so a
   * campaign never exists without its emails. Returns null if the idempotency key
   * was already used (the caller then loads the existing campaign).
   */
  async insertWithEmails(
    client: pg.PoolClient,
    campaign: NewCampaign,
    planned: PlannedEmail[],
  ): Promise<{ campaign: Campaign; emails: Email[] } | null> {
    const inserted = await client.query<Campaign>(
      `INSERT INTO campaigns
         (user_id, sender_id, subject, body, start_at, delay_between_ms, hourly_limit, total_recipients, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        campaign.userId,
        campaign.senderId,
        campaign.subject,
        campaign.body,
        campaign.startAt,
        campaign.delayBetweenMs,
        campaign.hourlyLimit,
        planned.length,
        campaign.idempotencyKey,
        campaign.requestHash,
      ],
    );
    const row = inserted.rows[0];
    if (!row) return null;

    const emails = await client.query<Email>(
      `INSERT INTO emails (campaign_id, user_id, sender_id, recipient, subject, body, scheduled_at)
       SELECT $1, $2, $3, r.recipient, $4, $5, r.scheduled_at
       FROM unnest($6::text[], $7::timestamptz[]) AS r(recipient, scheduled_at)
       RETURNING *`,
      [
        row.id,
        campaign.userId,
        campaign.senderId,
        campaign.subject,
        campaign.body,
        planned.map((p) => p.recipient),
        planned.map((p) => p.scheduledAt),
      ],
    );
    return { campaign: row, emails: emails.rows };
  },
};
