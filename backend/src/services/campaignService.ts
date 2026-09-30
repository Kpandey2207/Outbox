import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { advisoryXactLock, withTransaction } from '../db/pool.js';
import type { Campaign } from '../models/types.js';
import { enqueueEmails } from '../queue/emailQueue.js';
import { campaignRepository } from '../repositories/campaignRepository.js';
import { emailRepository } from '../repositories/emailRepository.js';
import { senderRepository } from '../repositories/senderRepository.js';
import { AppError, badRequest, notFound } from '../utils/errors.js';
import { attachmentService } from './attachmentService.js';
import { normalizeRecipients, planSchedule } from './scheduling.js';
import { searchService } from './searchService.js';

export interface CreateCampaignInput {
  userId: string;
  senderId: string;
  subject: string;
  body: string;
  recipients: string[];
  startAt: Date;
  delayBetweenMs: number;
  hourlyLimit: number;
  attachmentIds?: string[];
  idempotencyKey: string | null;
}

export interface CreateCampaignResult {
  campaign: Campaign;
  scheduled: number;
  firstSendAt: Date;
  lastSendAt: Date;
  replayed: boolean;
}

export const campaignService = {
  /**
   * Campaign and emails are committed in one Postgres transaction (the source of truth), then
   * one delayed job per email is enqueued, keyed by email id. If the process dies in between,
   * the watchdog or a retry with the same Idempotency-Key enqueues what is missing. The same
   * key with a different request is refused; without a key every request is a new campaign.
   */
  async create(input: CreateCampaignInput): Promise<CreateCampaignResult> {
    const requestHash = hashRequest(input);
    if (input.idempotencyKey) {
      const existing = await campaignRepository.findByIdempotencyKey(input.userId, input.idempotencyKey);
      if (existing) return replay(existing, requestHash);
    }

    const sender = await senderRepository.findForUser(input.userId, input.senderId);
    if (!sender) throw notFound('Sender not found');

    const { valid, invalid } = normalizeRecipients(input.recipients);
    if (valid.length === 0) throw badRequest('Add at least one valid recipient');
    if (invalid.length > 0) {
      const shown = invalid.slice(0, 5).join(', ') + (invalid.length > 5 ? ` and ${invalid.length - 5} more` : '');
      throw badRequest(`Not valid email addresses: ${shown}`, { invalid: invalid.slice(0, 20) });
    }
    if (!hasVisibleContent(input.body)) throw badRequest('Write a message: the body is empty');
    // Every email row keeps its own copy of the body, so bound the total a single request can write.
    const volume = Buffer.byteLength(input.body) * valid.length;
    if (volume > env.MAX_CAMPAIGN_BYTES) {
      throw badRequest(
        `This campaign is too large (${Math.ceil(volume / 1024 / 1024)} MB of email bodies). Shorten the body or split the recipients.`,
      );
    }

    const hourlyLimit = Math.min(input.hourlyLimit, env.MAX_EMAILS_PER_HOUR_PER_SENDER);
    const delayBetweenMs = Math.max(input.delayBetweenMs, env.MIN_DELAY_BETWEEN_SENDS_MS);
    const startAt = new Date(Math.max(input.startAt.getTime(), Date.now()));
    const plan = planSchedule({ recipients: valid, startAt, delayBetweenMs, hourlyLimit });

    const created = await withTransaction(async (client) => {
      // Bounds unsent mail per account across campaigns. The lock makes the check and the
      // insert one step for this user.
      await advisoryXactLock(client, `campaigns:${input.userId}`);
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM emails WHERE user_id = $1 AND status IN ('scheduled', 'sending')`,
        [input.userId],
      );
      if (rows[0]!.n + plan.length > env.MAX_SCHEDULED_PER_USER) {
        throw badRequest(
          `You can have up to ${env.MAX_SCHEDULED_PER_USER.toLocaleString('en-US')} emails waiting to be sent. Wait for some to go out or cancel a campaign.`,
        );
      }
      const result = await campaignRepository.insertWithEmails(
        client,
        {
          userId: input.userId,
          senderId: sender.id,
          subject: input.subject,
          body: input.body,
          startAt,
          delayBetweenMs,
          hourlyLimit,
          idempotencyKey: input.idempotencyKey,
          requestHash,
        },
        plan,
      );
      if (result && input.attachmentIds?.length) {
        await attachmentService.linkToCampaign(client, input.userId, result.campaign.id, input.attachmentIds);
      }
      return result;
    });
    if (!created) {
      // Lost a race with a concurrent request carrying the same key.
      const existing = await campaignRepository.findByIdempotencyKey(input.userId, input.idempotencyKey!);
      return replay(existing!, requestHash);
    }

    // Indexed first, so a status update from an early send can never be overwritten by
    // this initial "scheduled" document. Search failures are logged, never thrown.
    await searchService.indexEmails(created.emails, sender.email);
    await enqueueEmails(created.emails);
    logger.info({ campaignId: created.campaign.id, count: created.emails.length }, 'campaign scheduled');

    return {
      campaign: created.campaign,
      scheduled: created.emails.length,
      firstSendAt: plan[0]!.scheduledAt,
      lastSendAt: plan[plan.length - 1]!.scheduledAt,
      replayed: false,
    };
  },
};

/** An editor's empty paragraph (`<p><br></p>`, `&nbsp;`) is not a message. An image is. */
function hasVisibleContent(html: string): boolean {
  if (/<img\b/i.test(html)) return true;
  const text = html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/[\s\u200b]+/g, '');
  return text.length > 0;
}

/**
 * What the request asked for, so a reused Idempotency-Key with different content is caught.
 * The start time is left out on purpose: "send now" clicked again after a lost response picks
 * a new instant but is the same campaign.
 */
function hashRequest(input: CreateCampaignInput): Buffer {
  const canonical = JSON.stringify([
    input.senderId,
    input.subject,
    input.body,
    input.recipients.map((r) => r.trim().toLowerCase()),
    input.delayBetweenMs,
    input.hourlyLimit,
    [...(input.attachmentIds ?? [])].sort(),
  ]);
  return createHash('sha256').update(canonical).digest();
}

async function replay(campaign: Campaign, requestHash: Buffer): Promise<CreateCampaignResult> {
  if (campaign.request_hash && !campaign.request_hash.equals(requestHash)) {
    throw new AppError(
      422,
      'idempotency_key_reused',
      'A campaign was already scheduled with this request key, with different content. Check Scheduled before sending again.',
    );
  }
  // The first attempt may have died after committing but before enqueueing. Adding a job
  // that already exists is a no-op (jobId = email id), so this only fills gaps.
  await enqueueEmails(await emailRepository.scheduledForCampaign(campaign.id));
  const bounds = await campaignRepository.scheduleBounds(campaign.id);
  return {
    campaign,
    scheduled: campaign.total_recipients,
    firstSendAt: bounds.first,
    lastSendAt: bounds.last,
    replayed: true,
  };
}
