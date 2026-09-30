import { pool, type Queryable } from '../db/pool.js';
import type { Email, EmailForSending, EmailStatus } from '../models/types.js';

export type EmailView = 'scheduled' | 'sent' | 'starred' | 'archived';

export interface ViewFilter {
  statuses: EmailStatus[];
  /** false: only emails not archived; true: only archived; undefined: either. */
  archived?: boolean;
  starredOnly?: boolean;
}

/** Cancelled emails are not shown anywhere; deleted ones never are (see `list`). */
const VISIBLE: EmailStatus[] = ['scheduled', 'sending', 'sent', 'failed'];

/**
 * The dashboard's mailboxes. In-flight mail stays under Scheduled; failures show under Sent.
 * Starred and Archived cut across both, like labels.
 */
export const VIEWS: Record<EmailView, ViewFilter> = {
  scheduled: { statuses: ['scheduled', 'sending'], archived: false },
  sent: { statuses: ['sent', 'failed'], archived: false },
  starred: { statuses: VISIBLE, starredOnly: true },
  archived: { statuses: VISIBLE, archived: true },
};

/** The same test as viewWhere, for rows already loaded (search hits hydrated from Postgres). */
export function inView(email: Email, view: EmailView, only?: EmailStatus): boolean {
  const f = VIEWS[view];
  if (!viewStatuses(view, only).includes(email.status) || email.deleted_at) return false;
  if (f.archived === false && email.archived_at) return false;
  if (f.archived === true && !email.archived_at) return false;
  if (f.starredOnly && !email.starred) return false;
  return true;
}

function viewWhere(view: EmailView): string {
  const f = VIEWS[view];
  let where = 'e.user_id = $1 AND e.status = ANY($2::email_status[]) AND e.deleted_at IS NULL';
  if (f.archived === false) where += ' AND e.archived_at IS NULL';
  if (f.archived === true) where += ' AND e.archived_at IS NOT NULL';
  if (f.starredOnly) where += ' AND e.starred';
  return where;
}

export interface ListOptions {
  userId: string;
  view: EmailView;
  limit: number;
  offset: number;
  /** Plain substring search, used only when Elasticsearch is unavailable. */
  q?: string;
  /** Keep only this status (must be one the view shows, or nothing matches). */
  only?: EmailStatus;
}

export function viewStatuses(view: EmailView, only?: EmailStatus): EmailStatus[] {
  const all = VIEWS[view].statuses;
  return only ? all.filter((s) => s === only) : all;
}

export interface EmailListItem extends Email {
  sender_email: string;
  sender_name: string | null;
  owner_email: string;
  owner_name: string | null;
}

const LIST_SELECT = `SELECT e.*, s.email AS sender_email, s.display_name AS sender_name,
    u.email AS owner_email, u.name AS owner_name
  FROM emails e JOIN senders s ON s.id = e.sender_id JOIN users u ON u.id = e.user_id`;

export const emailRepository = {
  async findById(id: string, db: Queryable = pool): Promise<Email | null> {
    const { rows } = await db.query<Email>('SELECT * FROM emails WHERE id = $1', [id]);
    return rows[0] ?? null;
  },

  async findForUser(userId: string, id: string, db: Queryable = pool): Promise<EmailListItem | null> {
    const { rows } = await db.query<EmailListItem>(`${LIST_SELECT} WHERE e.id = $1 AND e.user_id = $2 AND e.deleted_at IS NULL`, [
      id,
      userId,
    ]);
    return rows[0] ?? null;
  },

  async findManyForUser(userId: string, ids: string[], db: Queryable = pool): Promise<EmailListItem[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query<EmailListItem>(
      `${LIST_SELECT} WHERE e.user_id = $1 AND e.id = ANY($2::uuid[]) AND e.deleted_at IS NULL`,
      [userId, ids],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is EmailListItem => Boolean(r));
  },

  async list(opts: ListOptions, db: Queryable = pool): Promise<{ items: EmailListItem[]; total: number }> {
    const params: unknown[] = [opts.userId, viewStatuses(opts.view, opts.only)];
    let where = viewWhere(opts.view);
    if (opts.q) {
      params.push(`%${opts.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
      where += ` AND (e.recipient ILIKE $3 OR e.subject ILIKE $3 OR e.body ILIKE $3)`;
    }
    const order =
      opts.view === 'scheduled'
        ? 'e.scheduled_at ASC, e.id'
        : opts.view === 'sent'
          ? 'COALESCE(e.sent_at, e.updated_at) DESC, e.id'
          : 'COALESCE(e.sent_at, e.scheduled_at) DESC, e.id';
    const count = await db.query<{ total: number }>(
      `SELECT count(*) AS total FROM emails e WHERE ${where}`,
      params,
    );
    params.push(opts.limit, opts.offset);
    const { rows } = await db.query<EmailListItem>(
      `${LIST_SELECT} WHERE ${where} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: rows, total: count.rows[0]?.total ?? 0 };
  },

  async counts(userId: string, db: Queryable = pool): Promise<Record<EmailView, number>> {
    const { rows } = await db.query<Record<EmailView, number>>(
      `SELECT
         count(*) FILTER (WHERE status IN ('scheduled', 'sending') AND archived_at IS NULL)::int AS scheduled,
         count(*) FILTER (WHERE status IN ('sent', 'failed') AND archived_at IS NULL)::int AS sent,
         count(*) FILTER (WHERE starred)::int AS starred,
         count(*) FILTER (WHERE archived_at IS NOT NULL)::int AS archived
       FROM emails WHERE user_id = $1 AND deleted_at IS NULL AND status <> 'cancelled'`,
      [userId],
    );
    return rows[0]!;
  },

  /**
   * Star / archive. Organisation only: delivery ignores both flags. updated_at is left alone
   * because it orders failed emails in Sent.
   */
  async setFlags(
    userId: string,
    id: string,
    flags: { starred?: boolean; archived?: boolean },
    db: Queryable = pool,
  ): Promise<Email | null> {
    const { rows } = await db.query<Email>(
      `UPDATE emails SET
         starred = COALESCE($3::boolean, starred),
         archived_at = CASE WHEN $4::boolean IS NULL THEN archived_at
                            WHEN $4::boolean THEN COALESCE(archived_at, now())
                            ELSE NULL END
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [id, userId, flags.starred ?? null, flags.archived ?? null],
    );
    return rows[0] ?? null;
  },

  /**
   * Hides an email from every mailbox. A scheduled one is cancelled in the same UPDATE, so
   * it races safely with claimForSending: whichever changes `status` first wins. A row that
   * is mid-send is left alone. The row itself is kept, so idempotency and history hold.
   */
  async softDelete(userId: string, id: string, db: Queryable = pool): Promise<{ email: Email; wasScheduled: boolean } | null> {
    const { rows } = await db.query<Email & { was_scheduled: boolean }>(
      `UPDATE emails e SET deleted_at = now(), updated_at = now(),
         status = CASE WHEN e.status = 'scheduled' THEN 'cancelled'::email_status ELSE e.status END
       FROM (SELECT id, status = 'scheduled' AS was_scheduled FROM emails WHERE id = $1 FOR UPDATE) prev
       WHERE e.id = prev.id AND e.user_id = $2 AND e.deleted_at IS NULL AND e.status <> 'sending'
       RETURNING e.*, prev.was_scheduled`,
      [id, userId],
    );
    const row = rows[0];
    if (!row) return null;
    const { was_scheduled, ...email } = row;
    return { email, wasScheduled: was_scheduled };
  },

  // State transitions. Each is a single conditional UPDATE, so two workers racing on a row
  // can never both win. Writes made for a claim carry its claim_token (a fencing token): a
  // worker that stalled past its lease and lost the row to recovery cannot move it any more.

  /**
   * scheduled -> sending, with a fresh claim token. Only one caller can succeed for a given
   * row; everyone else gets null.
   */
  async claimForSending(id: string, db: Queryable = pool): Promise<EmailForSending | null> {
    const { rows } = await db.query<EmailForSending>(
      `WITH claimed AS (
         UPDATE emails SET status = 'sending', sending_started_at = now(), updated_at = now(),
           claim_token = gen_random_uuid(), smtp_started_at = NULL
         WHERE id = $1 AND status = 'scheduled'
         RETURNING *
       )
       SELECT claimed.*, c.hourly_limit, c.delay_between_ms, s.email AS sender_email,
              s.display_name AS sender_display_name, u.email AS owner_email, u.name AS owner_name
       FROM claimed
       JOIN campaigns c ON c.id = claimed.campaign_id
       JOIN senders s ON s.id = claimed.sender_id
       JOIN users u ON u.id = claimed.user_id`,
      [id],
    );
    return rows[0] ?? null;
  },

  /**
   * Records "the SMTP conversation is about to start" before any byte goes out. Until this
   * row write succeeds nothing is sent, so a row interrupted with smtp_started_at NULL is
   * provably unsent. False means this claim no longer owns the row: do not send.
   */
  async beginSmtp(id: string, claimToken: string, db: Queryable = pool): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE emails SET smtp_started_at = now()
       WHERE id = $1 AND status = 'sending' AND claim_token = $2`,
      [id, claimToken],
    );
    return rowCount === 1;
  },

  /**
   * sending -> scheduled at a later time, because a rate limit or throttle said "not yet".
   * Only hourly-limit moves count as reschedules; waiting a few seconds for the send gap does not.
   */
  async releaseForReschedule(id: string, claimToken: string, scheduledAt: Date, countAsReschedule: boolean, db: Queryable = pool): Promise<void> {
    await db.query(
      `UPDATE emails SET status = 'scheduled', scheduled_at = $3, sending_started_at = NULL,
         claim_token = NULL, smtp_started_at = NULL,
         reschedule_count = reschedule_count + CASE WHEN $4::boolean THEN 1 ELSE 0 END, updated_at = now()
       WHERE id = $1 AND status = 'sending' AND claim_token = $2`,
      [id, claimToken, scheduledAt, countAsReschedule],
    );
  },

  /** sending -> scheduled, same time, when an attempt failed before SMTP could start. */
  async releaseClaim(id: string, claimToken: string, db: Queryable = pool): Promise<void> {
    await db.query(
      `UPDATE emails SET status = 'scheduled', sending_started_at = NULL, claim_token = NULL, updated_at = now()
       WHERE id = $1 AND status = 'sending' AND claim_token = $2 AND smtp_started_at IS NULL`,
      [id, claimToken],
    );
  },

  /**
   * sending -> sent. The only way a row reaches `sent`. Also accepts `failed`, so the true
   * outcome wins if recovery had already written this very attempt off as "outcome unknown"
   * (the claim token proves it is the same attempt).
   */
  async markSent(id: string, claimToken: string, messageId: string, previewUrl: string | null, db: Queryable = pool): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE emails SET status = 'sent', sent_at = now(), attempts = attempts + 1, message_id = $3,
         preview_url = $4, last_error = NULL, sending_started_at = NULL, updated_at = now()
       WHERE id = $1 AND claim_token = $2 AND status IN ('sending', 'failed')`,
      [id, claimToken, messageId, previewUrl],
    );
    return rowCount === 1;
  },

  /** sending -> scheduled (BullMQ will retry) or failed (no attempts left, or not retryable). */
  async markAttemptFailed(id: string, claimToken: string, error: string, final: boolean, db: Queryable = pool): Promise<void> {
    await db.query(
      `UPDATE emails SET status = $4::email_status, attempts = attempts + 1, last_error = $3,
         sending_started_at = NULL, smtp_started_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'sending' AND claim_token = $2`,
      [id, claimToken, error.slice(0, 2000), final ? 'failed' : 'scheduled'],
    );
  },

  /**
   * A worker died (or stalled) holding this row past its lease. What happens next depends
   * on how far it got, which the row itself records:
   *   - smtp_started_at NULL: SMTP never started, so the email goes back to `scheduled` and
   *     is sent normally. No duplicate is possible.
   *   - smtp_started_at set: the message may or may not have been accepted. It is failed with
   *     an explicit "outcome unknown", never resent: never sending twice beats always sending.
   * Returns the new status, or null if the lease has not expired or someone else resolved it.
   */
  async resolveInterrupted(id: string, leaseMs: number, db: Queryable = pool): Promise<'scheduled' | 'failed' | null> {
    const { rows } = await db.query<{ status: 'scheduled' | 'failed' }>(
      `UPDATE emails SET
         status = CASE WHEN smtp_started_at IS NULL THEN 'scheduled'::email_status ELSE 'failed'::email_status END,
         last_error = CASE WHEN smtp_started_at IS NULL THEN last_error
           ELSE 'Worker stopped while talking to the mail server; delivery outcome unknown, not retried to avoid a duplicate' END,
         sending_started_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'sending'
         AND sending_started_at < now() - ($2::int * interval '1 millisecond')
       RETURNING status`,
      [id, leaseMs],
    );
    return rows[0]?.status ?? null;
  },

  /** sending -> sent from the delivery journal, when SMTP accepted it but the write was lost. */
  async markRecoveredSent(id: string, messageId: string, previewUrl: string | null, db: Queryable = pool): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE emails SET status = 'sent', sent_at = now(), attempts = attempts + 1, message_id = $2,
         preview_url = $3, last_error = NULL, sending_started_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'sending'`,
      [id, messageId, previewUrl],
    );
    return rowCount === 1;
  },

  async cancel(userId: string, id: string, db: Queryable = pool): Promise<Email | null> {
    const { rows } = await db.query<Email>(
      `UPDATE emails SET status = 'cancelled', updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status = 'scheduled' RETURNING *`,
      [id, userId],
    );
    return rows[0] ?? null;
  },

  /** Cancels every scheduled email a user has. Returns the ids so their jobs can be removed. */
  async cancelAllScheduled(userId: string, db: Queryable = pool): Promise<string[]> {
    const { rows } = await db.query<{ id: string }>(
      `UPDATE emails SET status = 'cancelled', updated_at = now()
       WHERE user_id = $1 AND status = 'scheduled' RETURNING id`,
      [userId],
    );
    return rows.map((r) => r.id);
  },

  async scheduledForCampaign(campaignId: string, db: Queryable = pool): Promise<Pick<Email, 'id' | 'scheduled_at'>[]> {
    const { rows } = await db.query<Pick<Email, 'id' | 'scheduled_at'>>(
      `SELECT id, scheduled_at FROM emails WHERE campaign_id = $1 AND status = 'scheduled'`,
      [campaignId],
    );
    return rows;
  },

  /** Keyset-paged scan of rows that should have a live BullMQ job. Used on worker boot. */
  async pendingPage(afterId: string | null, limit: number, db: Queryable = pool): Promise<Email[]> {
    const { rows } = await db.query<Email>(
      `SELECT * FROM emails WHERE status IN ('scheduled', 'sending') AND ($1::uuid IS NULL OR id > $1)
       ORDER BY id LIMIT $2`,
      [afterId, limit],
    );
    return rows;
  },

  /**
   * Rows that should have been picked up by now but evidently were not: `scheduled` and
   * overdue by more than `graceMs`, or `sending` past their lease by more than `graceMs`.
   * The watchdog checks these have a live job.
   */
  async strandedPage(graceMs: number, leaseMs: number, limit: number, db: Queryable = pool): Promise<Email[]> {
    const { rows } = await db.query<Email>(
      `SELECT * FROM emails
       WHERE (status = 'scheduled' AND scheduled_at < now() - ($1::int * interval '1 millisecond'))
          OR (status = 'sending' AND sending_started_at < now() - (($1::int + $2::int) * interval '1 millisecond'))
       ORDER BY scheduled_at LIMIT $3`,
      [graceMs, leaseMs, limit],
    );
    return rows;
  },

  async allPage(afterId: string | null, limit: number, db: Queryable = pool): Promise<EmailListItem[]> {
    const { rows } = await db.query<EmailListItem>(
      `${LIST_SELECT} WHERE ($1::uuid IS NULL OR e.id > $1) ORDER BY e.id LIMIT $2`,
      [afterId, limit],
    );
    return rows;
  },
};
