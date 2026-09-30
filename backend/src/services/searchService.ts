import { logger } from '../config/logger.js';
import { safeError } from '../utils/errors.js';
import { isSearchConfigured, searchIndex, type EmailDocument } from '../integrations/elasticsearch.js';
import { emailRepository, inView, VIEWS, viewStatuses, type EmailListItem, type EmailView } from '../repositories/emailRepository.js';
import type { Email, EmailStatus } from '../models/types.js';

export function toDocument(email: Email, senderEmail: string): EmailDocument {
  return {
    id: email.id,
    userId: email.user_id,
    campaignId: email.campaign_id,
    senderEmail,
    recipient: email.recipient,
    subject: email.subject,
    body: email.body.replace(/<[^>]+>/g, ' '),
    status: email.status,
    scheduledAt: new Date(email.scheduled_at).toISOString(),
    sentAt: email.sent_at ? new Date(email.sent_at).toISOString() : null,
    starred: Boolean(email.starred),
    archived: Boolean(email.archived_at),
    deleted: Boolean(email.deleted_at),
  };
}

/**
 * Postgres is the source of truth; Elasticsearch is a derived read model. Index writes are
 * best effort so a search outage never blocks scheduling or sending, and `npm run reindex`
 * rebuilds the index from Postgres at any time.
 */
export const searchService = {
  async indexEmails(emails: Email[], senderEmail: string): Promise<void> {
    try {
      await searchIndex.indexMany(emails.map((e) => toDocument(e, senderEmail)));
    } catch (err) {
      logger.warn({ err: safeError(err), count: emails.length }, 'elasticsearch indexing failed; run reindex to repair');
    }
  },

  async syncStatus(email: Pick<Email, 'id' | 'status' | 'sent_at' | 'scheduled_at'>): Promise<void> {
    try {
      await searchIndex.update(email.id, {
        status: email.status,
        sentAt: email.sent_at ? new Date(email.sent_at).toISOString() : null,
        scheduledAt: new Date(email.scheduled_at).toISOString(),
      });
    } catch (err) {
      logger.warn({ err: safeError(err), emailId: email.id }, 'elasticsearch status sync failed');
    }
  },

  async syncFlags(email: Pick<Email, 'id' | 'status' | 'starred' | 'archived_at' | 'deleted_at'>): Promise<void> {
    try {
      await searchIndex.update(email.id, {
        status: email.status,
        starred: email.starred,
        archived: Boolean(email.archived_at),
        deleted: Boolean(email.deleted_at),
      });
    } catch (err) {
      logger.warn({ err: safeError(err), emailId: email.id }, 'elasticsearch flag sync failed');
    }
  },

  /** Full-text search in Elasticsearch, falling back to a Postgres ILIKE scan if it is down. */
  async search(
    userId: string,
    view: EmailView,
    q: string,
    limit: number,
    offset: number,
    only?: EmailStatus,
  ): Promise<{ items: EmailListItem[]; total: number; engine: 'elasticsearch' | 'postgres' }> {
    if (isSearchConfigured()) {
      try {
        const hits = await searchIndex.search({
          userId,
          q,
          ...VIEWS[view],
          statuses: viewStatuses(view, only),
          from: offset,
          size: limit,
        });
        // Hydrate from Postgres so status and timestamps are always current. The index can lag
        // a status change by a moment; a hit that has since left this view is dropped.
        const items = (await emailRepository.findManyForUser(userId, hits.ids)).filter((e) => inView(e, view, only));
        return { items, total: hits.total, engine: 'elasticsearch' };
      } catch (err) {
        logger.warn({ err: safeError(err) }, 'elasticsearch search failed; falling back to postgres');
      }
    }
    const res = await emailRepository.list({ userId, view, q, limit, offset, only });
    return { ...res, engine: 'postgres' };
  },
};

