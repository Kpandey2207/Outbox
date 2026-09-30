import type { EmailStatus } from '../models/types.js';
import { emailQueue } from '../queue/emailQueue.js';
import { emailRepository, type EmailView } from '../repositories/emailRepository.js';
import { conflict, notFound } from '../utils/errors.js';
import { searchService } from './searchService.js';

export const emailService = {
  async list(userId: string, view: EmailView, q: string | undefined, page: number, pageSize: number, only?: EmailStatus) {
    const offset = (page - 1) * pageSize;
    if (q) {
      const res = await searchService.search(userId, view, q, pageSize, offset, only);
      return { items: res.items, total: res.total, page, pageSize, engine: res.engine };
    }
    const res = await emailRepository.list({ userId, view, limit: pageSize, offset, only });
    return { items: res.items, total: res.total, page, pageSize, engine: 'postgres' as const };
  },

  counts: (userId: string) => emailRepository.counts(userId),

  async get(userId: string, id: string) {
    const email = await emailRepository.findForUser(userId, id);
    if (!email) throw notFound('Email not found');
    return email;
  },

  async setFlags(userId: string, id: string, flags: { starred?: boolean; archived?: boolean }) {
    const updated = await emailRepository.setFlags(userId, id, flags);
    if (!updated) throw notFound('Email not found');
    await searchService.syncFlags(updated);
    return emailService.get(userId, id);
  },

  /** Removes an email from every mailbox; a scheduled one is cancelled first, atomically. */
  async remove(userId: string, id: string) {
    const deleted = await emailRepository.softDelete(userId, id);
    if (!deleted) {
      const existing = await emailRepository.findForUser(userId, id);
      if (!existing) throw notFound('Email not found');
      throw conflict('This email is being sent right now. Try again in a moment.');
    }
    if (deleted.wasScheduled) await emailQueue().remove(id).catch(() => undefined);
    await searchService.syncFlags(deleted.email);
  },

  /** Cancels a scheduled email. The DB transition is the guard; removing the job is cleanup. */
  async cancel(userId: string, id: string) {
    const cancelled = await emailRepository.cancel(userId, id);
    if (!cancelled) {
      const existing = await emailRepository.findForUser(userId, id);
      if (!existing) throw notFound('Email not found');
      throw conflict(`Email is already ${existing.status} and cannot be cancelled`);
    }
    // If the job is active right now remove() fails; the worker will see `cancelled` and skip.
    await emailQueue().remove(id).catch(() => undefined);
    await searchService.syncStatus(cancelled);
    return cancelled;
  },
};
