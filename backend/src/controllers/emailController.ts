import type { Request, Response } from 'express';
import { currentUser } from '../middleware/auth.js';
import type { EmailListItem } from '../repositories/emailRepository.js';
import { attachmentRepository } from '../repositories/attachmentRepository.js';
import { emailService } from '../services/emailService.js';
import { serializeAttachment } from './attachmentController.js';
import type { ListEmailsQuery, UpdateEmailBody } from '../validation/schemas.js';

/** API shape: camelCase, no internals. */
function serializeEmail(e: EmailListItem) {
  return {
    id: e.id,
    campaignId: e.campaign_id,
    // What recipients see: the signed-in user. `via` is the Ethereal account that relayed it.
    from: e.owner_email,
    fromName: e.owner_name,
    via: e.sender_email,
    to: e.recipient,
    subject: e.subject,
    body: e.body,
    status: e.status,
    scheduledAt: e.scheduled_at,
    sentAt: e.sent_at,
    attempts: e.attempts,
    rescheduleCount: e.reschedule_count,
    lastError: e.last_error,
    previewUrl: e.preview_url,
    starred: e.starred,
    archivedAt: e.archived_at,
    createdAt: e.created_at,
  };
}

export const emailController = {
  async list(req: Request, res: Response) {
    const q = res.locals.query as ListEmailsQuery;
    const result = await emailService.list(currentUser(req).id, q.status, q.q, q.page, q.pageSize, q.only);
    res.json({ ...result, items: result.items.map(serializeEmail) });
  },

  async counts(req: Request, res: Response) {
    res.json(await emailService.counts(currentUser(req).id));
  },

  async get(req: Request, res: Response) {
    const { id } = res.locals.params as { id: string };
    const email = await emailService.get(currentUser(req).id, id);
    const attachments = await attachmentRepository.listMetaByCampaign(email.campaign_id);
    res.json({ ...serializeEmail(email), attachments: attachments.map(serializeAttachment) });
  },

  async update(req: Request, res: Response) {
    const { id } = res.locals.params as { id: string };
    const updated = await emailService.setFlags(currentUser(req).id, id, res.locals.body as UpdateEmailBody);
    res.json(serializeEmail(updated));
  },

  async remove(req: Request, res: Response) {
    const { id } = res.locals.params as { id: string };
    await emailService.remove(currentUser(req).id, id);
    res.status(204).end();
  },
};
