import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { logger } from '../config/logger.js';
import { SmtpSendError, type MailAttachment, type Mailer } from '../integrations/mailer.js';
import type { Email, EmailForSending, EmailSendJobData } from '../models/types.js';
import type { DeliveryJournal } from '../queue/deliveryJournal.js';
import type { RateLimiter } from '../queue/rateLimiter.js';
import { attachmentRepository } from '../repositories/attachmentRepository.js';
import { emailRepository } from '../repositories/emailRepository.js';
import { senderRepository } from '../repositories/senderRepository.js';
import type { notificationService } from '../services/notificationService.js';
import { HOUR_MS } from '../services/scheduling.js';
import { searchService } from '../services/searchService.js';

export interface ProcessorDeps {
  mailer: Mailer;
  limiter: RateLimiter;
  journal: DeliveryJournal;
  notifier: Pick<typeof notificationService, 'rateLimitReached'>;
  maxPerSenderPerHour: number;
  globalHourlyLimit: number;
  minDelayMs: number;
  leaseMs: number;
  /** Throttle waits up to this long are slept in-process instead of rescheduling the job. */
  inlineWaitMs?: number;
  /** First wait after a Postgres/Redis error before the claim; doubles up to 10 minutes. */
  infraRetryBaseMs?: number;
}

export type ProcessOutcome =
  | { outcome: 'sent'; messageId: string }
  | { outcome: 'skipped'; status: string }
  | { outcome: 'missing' }
  | { outcome: 'interrupted'; status: 'failed' | 'sent' };

/** `"Name" <email>`, with quotes stripped from the name so it cannot break the header. */
function formatAddress(name: string | null, email: string): string {
  const clean = name?.replace(/["\r\n]/g, '').trim();
  return clean ? `"${clean}" <${email}>` : email;
}

/**
 * A campaign's files are fixed once it is created, so every email of a campaign can reuse
 * one read. Kept small because each entry can hold up to MAX_ATTACHMENTS_TOTAL_BYTES.
 */
class AttachmentCache {
  private readonly entries = new Map<string, { at: number; files: MailAttachment[] }>();
  constructor(private readonly maxEntries = 8, private readonly ttlMs = 5 * 60_000) {}

  async get(campaignId: string): Promise<MailAttachment[]> {
    const hit = this.entries.get(campaignId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.files;
    const rows = await attachmentRepository.listWithDataByCampaign(campaignId);
    const files = rows.map((r) => ({ filename: r.filename, contentType: r.content_type, content: r.data }));
    this.entries.delete(campaignId);
    this.entries.set(campaignId, { at: Date.now(), files });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    return files;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries a short Postgres write through a brief blip before giving up. */
async function persist<T>(write: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await write();
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(Math.min(200 * 2 ** i, 3_000));
    }
  }
}

/** Park the job in BullMQ's delayed set until `at`, without using up a retry attempt. */
async function deferJob(job: Job, token: string | undefined, at: number): Promise<never> {
  await job.moveToDelayed(Math.max(at, Date.now()), token);
  throw new DelayedError();
}

/**
 * Sends one email. Safety comes from Postgres state transitions, not from the queue:
 *
 *  - Only a row in `scheduled` can be claimed, via a conditional UPDATE that also issues a
 *    claim token, so if BullMQ ever hands the same email to two workers only one gets past
 *    the claim, and only that claim's writes count afterwards.
 *  - A row that is `sent`, `failed` or `cancelled` is skipped, so a replayed or duplicated
 *    job can never send again.
 *  - Right before SMTP starts the row records smtp_started_at. A row a crashed worker left in
 *    `sending` is resent only if that mark is missing (SMTP provably never started), and
 *    failed as "outcome unknown" otherwise (see resolveInterrupted).
 *  - SMTP failures are retried only when nothing can have been delivered (see
 *    classifySmtpError); a broken connection after the message went out is never retried.
 *  - Limits are checked after the claim, and a "not yet" puts the row back to `scheduled`
 *    and moves the same job to a later time. Nothing is dropped and no new job is created.
 *
 * The one gap no code can close: SMTP accepted the message and the process died before any
 * record of that was written. The row then says "outcome unknown", never "sent twice".
 */
export function createEmailProcessor(deps: ProcessorDeps) {
  const inlineWaitMs = deps.inlineWaitMs ?? 1_000;
  const attachmentCache = new AttachmentCache();

  /** Search is a derived read model: never let it slow down or fail a send. */
  const syncSearch = (row: Pick<Email, 'id' | 'status' | 'sent_at' | 'scheduled_at'>) => {
    void searchService.syncStatus(row);
  };

  return async function processEmail(job: Job<EmailSendJobData>, token?: string): Promise<ProcessOutcome> {
    const log = logger.child({ emailId: job.data.emailId, jobId: job.id, attempt: job.attemptsMade + 1 });
    let prepared;
    try {
      prepared = await prepare(job, token, log);
    } catch (err) {
      if (err instanceof DelayedError) throw err;
      // Postgres or Redis trouble before anything was claimed. Nothing is at stake yet, so
      // wait and look again instead of spending one of the job's attempts: an outage longer
      // than the retry budget would otherwise leave the email scheduled with no job.
      const deferrals = (job.data.infraDeferrals ?? 0) + 1;
      const waitMs = Math.min((deps.infraRetryBaseMs ?? 5_000) * 2 ** Math.min(deferrals - 1, 7), 10 * 60_000);
      log.warn({ err: (err as Error).message, retryInMs: waitMs }, 'infrastructure error before claim; deferring');
      await job.updateData({ ...job.data, infraDeferrals: deferrals }).catch(() => undefined);
      return deferJob(job, token, Date.now() + waitMs);
    }
    if ('outcome' in prepared) return prepared;
    const { email, attachments } = prepared;
    const claimToken = email.claim_token!;

    let sender;
    try {
      const gate = await passLimits(job, token, email, claimToken, log);
      if (gate) return gate;
      sender = await senderRepository.findById(email.sender_id);
      if (!sender) {
        await emailRepository.markAttemptFailed(email.id, claimToken, 'Sender no longer exists', true);
        return { outcome: 'skipped', status: 'failed' };
      }
      // The point of no return is recorded before it is crossed. If this write fails, or the
      // row was taken over while we waited, nothing has been sent and nothing will be.
      if (!(await emailRepository.beginSmtp(email.id, claimToken))) {
        log.warn('lost the claim before sending; not sending');
        return { outcome: 'skipped', status: 'claim-lost' };
      }
    } catch (err) {
      if (err instanceof DelayedError) throw err;
      // Failed between the claim and SMTP: nothing was sent, so hand the row straight back
      // instead of leaving it in `sending` until its lease runs out.
      await emailRepository.releaseClaim(email.id, claimToken).catch(() => undefined);
      throw err;
    }

    let sent;
    try {
      sent = await deps.mailer.send(
        { senderId: sender.id, smtpUser: sender.smtp_user, smtpPass: sender.smtp_pass },
        {
          from: formatAddress(email.owner_name, email.owner_email),
          envelopeFrom: sender.email,
          replyTo: email.owner_email,
          to: email.recipient,
          subject: email.subject,
          html: email.body,
          messageId: `<${email.id}@outbox.local>`,
          attachments,
        },
      );
    } catch (err) {
      // Anything that is not a classified SMTP error is treated as "may have been sent".
      const failure =
        err instanceof SmtpSendError
          ? err
          : new SmtpSendError('unknown', 'Sending stopped unexpectedly; delivery outcome unknown, not retried to avoid a duplicate');
      const attemptsLeft = job.attemptsMade + 1 < (job.opts.attempts ?? 1);
      const final = failure.kind !== 'retryable' || !attemptsLeft;
      await persist(() => emailRepository.markAttemptFailed(email.id, claimToken, failure.message, final));
      if (final) {
        const failed = await emailRepository.findById(email.id);
        if (failed) syncSearch(failed);
      }
      log.warn({ kind: failure.kind, final, error: failure.message }, 'smtp send failed');
      // UnrecoverableError stops BullMQ from retrying what must not be retried.
      throw failure.kind === 'retryable' ? failure : new UnrecoverableError(failure.message);
    }

    // SMTP accepted it. Note that first in Redis (cheap, independent of Postgres), then make
    // the `sent` write survive a short database blip. If both fail, recovery still finds the
    // journal entry once the lease expires and records the email as sent, not resent.
    await deps.journal
      .record(email.id, sent)
      .catch((err) => log.error({ err: (err as Error).message }, 'could not journal a delivered email'));
    const recorded = await persist(() => emailRepository.markSent(email.id, claimToken, sent.messageId, sent.previewUrl));
    if (!recorded) log.error('email was delivered but its row had been taken over by recovery');
    syncSearch({ ...email, status: 'sent', sent_at: new Date() });
    log.info({ messageId: sent.messageId, preview: sent.previewUrl }, 'email sent');
    return { outcome: 'sent', messageId: sent.messageId };
  };

  /**
   * Everything up to and including the claim. Returns a final outcome, or the claimed row.
   * Throws DelayedError when the job was parked for later.
   */
  async function prepare(
    job: Job<EmailSendJobData>,
    token: string | undefined,
    log: typeof logger,
  ): Promise<ProcessOutcome | { email: EmailForSending; attachments: MailAttachment[] }> {
    const { emailId } = job.data;
    let current = await emailRepository.findById(emailId);
    if (!current) return { outcome: 'missing' };
    if (current.status === 'sent' || current.status === 'failed' || current.status === 'cancelled') {
      log.info({ status: current.status }, 'email already finalised; skipping');
      return { outcome: 'skipped', status: current.status };
    }
    if (current.status === 'sending') {
      // The lease is judged by Postgres' clock (resolveInterrupted), never this machine's.
      const recovered = await recoverInterrupted(current);
      if (recovered === null) {
        // Another attempt still holds the lease; look again once it has expired.
        const leaseEnds = new Date(current.sending_started_at ?? Date.now()).getTime() + deps.leaseMs;
        return deferJob(job, token, Math.max(leaseEnds, Date.now()) + 1_000);
      }
      if (recovered !== 'scheduled') {
        const row = await emailRepository.findById(emailId);
        if (row) syncSearch(row);
        return { outcome: 'interrupted', status: recovered };
      }
      log.warn('previous attempt stopped before SMTP started; sending normally');
      current = (await emailRepository.findById(emailId))!;
    }
    if (new Date(current.scheduled_at).getTime() > Date.now() + 1_000) {
      return deferJob(job, token, new Date(current.scheduled_at).getTime());
    }

    // Read before the claim, so a database hiccup here leaves the row `scheduled`.
    const attachments = await attachmentCache.get(current.campaign_id);

    const email = await emailRepository.claimForSending(emailId);
    if (!email) {
      log.info('email was claimed or cancelled concurrently; skipping');
      return { outcome: 'skipped', status: 'claimed-elsewhere' };
    }
    return { email, attachments };
  }

  /**
   * Asks the limiter for permission. Returns undefined when the email may go now; otherwise
   * the row is handed back as `scheduled` at the time the limiter gave, and the job is parked
   * until then (DelayedError).
   */
  async function passLimits(
    job: Job<EmailSendJobData>,
    token: string | undefined,
    email: EmailForSending,
    claimToken: string,
    log: typeof logger,
  ): Promise<ProcessOutcome | undefined> {
    const senderLimit = Math.min(email.hourly_limit, deps.maxPerSenderPerHour);
    const minDelayMs = Math.max(email.delay_between_ms, deps.minDelayMs);
    // Once per sender, per reason, per hour, whichever worker notices first. Fire and forget:
    // neither Slack nor its de-duplication key may hold up or fail a send.
    const alertLimitReached = (reason: 'sender_hourly_limit' | 'global_hourly_limit', window: number, resumesAt: Date, deferred: boolean) => {
      void (async () => {
        if (!(await deps.limiter.firstLimitHitThisHour(email.sender_id, window, reason))) return;
        await deps.notifier.rateLimitReached({
          userId: email.user_id,
          senderEmail: email.sender_email,
          limit: reason === 'sender_hourly_limit' ? senderLimit : deps.globalHourlyLimit,
          reason,
          resumesAt,
          deferred,
        });
      })().catch((err) => log.warn({ err: (err as Error).message }, 'limit alert failed'));
    };

    let reservedSlot = job.data.throttleSlot;
    for (let tries = 0; ; tries++) {
      const decision = await deps.limiter.acquire({
        senderId: email.sender_id,
        senderHourlyLimit: senderLimit,
        globalHourlyLimit: deps.globalHourlyLimit,
        minDelayMs,
        reservedSlot,
      });
      if (decision.allowed) {
        // This send used the sender's last slot for the hour: the limit is reached now.
        if (decision.senderCount >= senderLimit) {
          alertLimitReached('sender_hourly_limit', decision.window, new Date((decision.window + 1) * HOUR_MS), false);
        }
        return undefined;
      }

      const hourly = decision.reason === 'sender_hourly_limit' || decision.reason === 'global_hourly_limit';
      if (decision.reason === 'throttle') {
        // The limiter reserved this slot for us; short waits are slept here.
        reservedSlot = decision.retryAt;
        const waitMs = decision.retryAt - Date.now();
        if (waitMs <= inlineWaitMs && tries < 20) {
          await sleep(Math.max(waitMs, 5));
          continue;
        }
      }

      // Hour windows follow Redis' clock; wake a little after the window turns so a worker
      // clock running slightly ahead cannot knock at the full hour again.
      const runAt = decision.retryAt + (hourly ? 1_000 : 0);
      const retryAt = new Date(runAt);
      await emailRepository.releaseForReschedule(email.id, claimToken, retryAt, hourly);
      syncSearch({ ...email, status: 'scheduled', scheduled_at: retryAt });
      log.info({ reason: decision.reason, retryAt }, 'send deferred by limiter');
      if (hourly) alertLimitReached(decision.reason as 'sender_hourly_limit' | 'global_hourly_limit', decision.window, retryAt, true);
      await job
        .updateData({ ...job.data, throttleSlot: decision.reason === 'throttle' ? decision.retryAt : undefined })
        .catch(() => undefined);
      return deferJob(job, token, runAt);
    }
  }

  /** Resolves a row whose worker stopped mid-attempt and whose lease has expired. */
  async function recoverInterrupted(row: Email): Promise<'scheduled' | 'failed' | 'sent' | null> {
    const delivered = await deps.journal.find(row.id).catch(() => null);
    if (delivered) {
      return (await emailRepository.markRecoveredSent(row.id, delivered.messageId, delivered.previewUrl)) ? 'sent' : null;
    }
    const status = await emailRepository.resolveInterrupted(row.id, deps.leaseMs);
    if (status === 'failed') logger.warn({ emailId: row.id }, 'email interrupted during SMTP; outcome unknown, marked failed');
    return status;
  }
}
