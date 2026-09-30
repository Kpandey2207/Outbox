import type { Worker } from 'bullmq';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { closeSharedRedis, sharedRedis } from '../src/queue/connection.js';
import { closeEmailQueue, emailQueue } from '../src/queue/emailQueue.js';
import { DeliveryJournal } from '../src/queue/deliveryJournal.js';
import { RateLimiter } from '../src/queue/rateLimiter.js';
import { attachmentService } from '../src/services/attachmentService.js';
import { campaignService } from '../src/services/campaignService.js';
import { emailService } from '../src/services/emailService.js';
import type { ProcessorDeps } from '../src/workers/emailProcessor.js';
import { createEmailWorker } from '../src/workers/emailWorker.js';
import { markQueueEpoch, reconcilePendingJobs, watchdogSweep } from '../src/workers/reconcile.js';
import { emailRepository } from '../src/repositories/emailRepository.js';
import { createUserWithSender, FakeMailer, resetState, waitFor } from './helpers.js';

const statusCounts = async () => {
  const { rows } = await pool.query<{ status: string; n: number }>('SELECT status, count(*) AS n FROM emails GROUP BY status');
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
};

function deps(mailer: FakeMailer, overrides: Partial<ProcessorDeps> = {}): ProcessorDeps {
  return {
    mailer,
    limiter: new RateLimiter(sharedRedis(), `test:rl:${Math.random().toString(36).slice(2)}`),
    journal: new DeliveryJournal(sharedRedis()),
    notifier: { rateLimitReached: vi.fn(async () => true) },
    maxPerSenderPerHour: 10_000,
    globalHourlyLimit: 10_000,
    minDelayMs: 0,
    leaseMs: 60_000,
    ...overrides,
  };
}

const recipients = (n: number, tag = 'r') => Array.from({ length: n }, (_, i) => `${tag}${i}@example.com`);

describe('email worker', () => {
  let workers: Worker[] = [];

  beforeEach(async () => {
    await resetState();
  });

  afterEach(async () => {
    await Promise.all(workers.map((w) => w.close()));
    workers = [];
  });

  afterAll(async () => {
    await closeEmailQueue();
    await closeSharedRedis();
    await pool.end();
  });

  it('sends every email exactly once with several concurrent workers', async () => {
    const { user, sender } = await createUserWithSender();
    const mailer = new FakeMailer();
    mailer.delayMs = 20;
    const shared = deps(mailer);
    workers = [1, 2, 3].map(() => createEmailWorker(shared, 5));

    await campaignService.create({
      userId: user.id, senderId: sender.id, subject: 'Hi', body: '<p>Hello</p>',
      recipients: recipients(40), startAt: new Date(), delayBetweenMs: 0, hourlyLimit: 1000, idempotencyKey: null,
    });

    await waitFor(async () => (await statusCounts()).sent === 40);
    expect(mailer.sent).toHaveLength(40);
    expect(new Set(mailer.sent.map((m) => m.to)).size).toBe(40);
  });

  it('sends the campaign\'s attachments with every email', async () => {
    const { user, sender } = await createUserWithSender();
    const mailer = new FakeMailer();
    const [file] = await attachmentService.upload(user.id, [
      { originalname: 'deck.pdf', mimetype: 'application/octet-stream', buffer: Buffer.from('%PDF-1.4 deck') },
    ]);
    workers = [createEmailWorker(deps(mailer), 5)];
    await campaignService.create({
      userId: user.id, senderId: sender.id, subject: 'Hi', body: '<p>See attached</p>',
      recipients: recipients(3), startAt: new Date(), delayBetweenMs: 0, hourlyLimit: 100,
      attachmentIds: [file!.id], idempotencyKey: null,
    });

    await waitFor(async () => (await statusCounts()).sent === 3);
    for (const m of mailer.sent) {
      expect(m.attachments).toHaveLength(1);
      expect(m.attachments![0]).toMatchObject({ filename: 'deck.pdf', contentType: 'application/pdf' });
      expect(m.attachments![0]!.content.toString()).toBe('%PDF-1.4 deck');
    }
  });

  it('does not send again when the same email is enqueued twice or replayed', async () => {
    const { user, sender } = await createUserWithSender();
    const mailer = new FakeMailer();
    const result = await campaignService.create({
      userId: user.id, senderId: sender.id, subject: 'Hi', body: 'x',
      recipients: ['one@example.com'], startAt: new Date(), delayBetweenMs: 0, hourlyLimit: 10, idempotencyKey: null,
    });
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM emails WHERE campaign_id = $1', [result.campaign.id]);
    const id = rows[0]!.id;
    // Same job id twice: BullMQ keeps one job.
    await emailQueue().add('send-email', { emailId: id }, { jobId: id });
    workers = [createEmailWorker(deps(mailer), 5)];
    await waitFor(async () => (await statusCounts()).sent === 1);

    // A brand new job for an already-sent email (e.g. restored by hand) is a no-op.
    await emailQueue().add('send-email', { emailId: id }, { jobId: `${id}-replay` });
    await waitFor(async () => (await emailQueue().getJob(`${id}-replay`))?.finishedOn !== undefined);
    expect(mailer.sent).toHaveLength(1);
  });

  it('reschedules emails over the hourly limit instead of dropping them, and alerts once', async () => {
    const { user, sender } = await createUserWithSender();
    const mailer = new FakeMailer();
    const d = deps(mailer);
    workers = [createEmailWorker(d, 10)];

    await campaignService.create({
      userId: user.id, senderId: sender.id, subject: 'Hi', body: 'x',
      // The plan itself respects the limit, so start two campaigns to overload the sender.
      recipients: recipients(4, 'a'), startAt: new Date(), delayBetweenMs: 0, hourlyLimit: 3, idempotencyKey: null,
    });
    await campaignService.create({
      userId: user.id, senderId: sender.id, subject: 'Hi', body: 'x',
      recipients: recipients(3, 'b'), startAt: new Date(), delayBetweenMs: 0, hourlyLimit: 3, idempotencyKey: null,
    });

    await waitFor(async () => {
      const c = await statusCounts();
      return c.sent === 3 && (await emailQueue().getDelayedCount()) === 4;
    });
    const { rows } = await pool.query<{ status: string; scheduled_at: Date; reschedule_count: number }>(
      `SELECT status, scheduled_at, reschedule_count FROM emails WHERE status = 'scheduled'`,
    );
    const nextHour = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
    // One from campaign b was limiter-deferred; campaign a's 4th was already planned for the next hour.
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => new Date(r.scheduled_at).getTime() >= nextHour - 1)).toBe(true);
    expect(rows.filter((r) => r.reschedule_count === 1).length).toBe(3);
    expect(mailer.sent).toHaveLength(3);
    await waitFor(async () => (d.notifier.rateLimitReached as ReturnType<typeof vi.fn>).mock.calls.length === 1);
  });

  it('alerts the moment a sender uses its last slot of the hour, even with nothing left to defer', async () => {
    const { user, sender } = await createUserWithSender();
    const mailer = new FakeMailer();
    const d = deps(mailer);
    workers = [createEmailWorker(d, 5)];
    await campaignService.create({
      userId: user.id, senderId: sender.id, subject: 'Hi', body: 'x',
      recipients: recipients(3), startAt: new Date(), delayBetweenMs: 0, hourlyLimit: 3, idempotencyKey: null,
    });
    await waitFor(async () => (await statusCounts()).sent === 3);
    await waitFor(async () => (d.notifier.rateLimitReached as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    expect((d.notifier.rateLimitReached as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      userId: user.id,
      reason: 'sender_hourly_limit',
      limit: 3,
    });
  });

  it('keeps sending when the user has not connected Slack', async () => {
    const { notificationService } = await import('../src/services/notificationService.js');
    const { user } = await createUserWithSender();
    await expect(
      notificationService.rateLimitReached({ userId: user.id, senderEmail: 's@x.io', limit: 1, reason: 'sender_hourly_limit', resumesAt: new Date() }),
    ).resolves.toBe(false);
  });

  it('keeps the minimum gap when campaigns on one sender compete, without counting waits as reschedules', async () => {
    const { user, sender } = await createUserWithSender();
    const mailer = new FakeMailer();
    workers = [createEmailWorker(deps(mailer), 5)];
    for (const tag of ['a', 'b']) {
      await campaignService.create({
        userId: user.id, senderId: sender.id, subject: tag, body: 'x',
        recipients: recipients(5, tag), startAt: new Date(), delayBetweenMs: 300, hourlyLimit: 100, idempotencyKey: null,
      });
    }
    await waitFor(async () => (await statusCounts()).sent === 10, 30_000);
    expect(mailer.sent).toHaveLength(10);
    const times = [...mailer.sentAt].sort((x, y) => x - y);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(280);
    const { rows } = await pool.query<{ total: number }>('SELECT sum(reschedule_count)::int AS total FROM emails');
    expect(rows[0]!.total).toBe(0);
  });

  it('waits out a database outage before the claim without using up the job\'s attempts', async () => {
    const { user, sender } = await createUserWithSender();
    const mailer = new FakeMailer();
    const spy = vi.spyOn(emailRepository, 'findById');
    for (let i = 0; i < 5; i++) spy.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    workers = [createEmailWorker(deps(mailer, { infraRetryBaseMs: 20 }), 1)];
    await campaignService.create({
      userId: user.id, senderId: sender.id, subject: 'Hi', body: 'x',
      recipients: ['outage@example.com'], startAt: new Date(), delayBetweenMs: 0, hourlyLimit: 10, idempotencyKey: null,
    });
    await waitFor(async () => (await statusCounts()).sent === 1);
    spy.mockRestore();
    expect(mailer.sent).toHaveLength(1);
  });

  it('notices while running that Redis lost its jobs, and restores them without a restart', async () => {
    const { user, sender } = await createUserWithSender();
    const mailer = new FakeMailer();
    await markQueueEpoch();
    await campaignService.create({
      userId: user.id, senderId: sender.id, subject: 'Hi', body: 'x',
      recipients: recipients(3), startAt: new Date(Date.now() + 500), delayBetweenMs: 0, hourlyLimit: 10, idempotencyKey: null,
    });
    workers = [createEmailWorker(deps(mailer), 5)];
    // Redis loses everything (restart without persistence, FLUSHALL) while the worker keeps running.
    await sharedRedis().flushdb();
    const sweep = await watchdogSweep();
    expect(sweep).toEqual({ full: true, restored: 3 });
    await waitFor(async () => (await statusCounts()).sent === 3);
    expect(mailer.sent).toHaveLength(3);
  });

  it('re-queues an overdue email whose job BullMQ gave up on', async () => {
    const { user, sender } = await createUserWithSender();
    const mailer = new FakeMailer();
    await markQueueEpoch();
    await campaignService.create({
      userId: user.id, senderId: sender.id, subject: 'Hi', body: 'x',
      recipients: ['stranded@example.com'], startAt: new Date(Date.now() + 60_000), delayBetweenMs: 0, hourlyLimit: 10, idempotencyKey: null,
    });
    const { rows } = await pool.query<{ id: string }>(`UPDATE emails SET scheduled_at = now() - interval '10 minutes' RETURNING id`);
    await emailQueue().remove(rows[0]!.id);
    workers = [createEmailWorker(deps(mailer), 1)];
    expect(await watchdogSweep(60_000)).toEqual({ full: false, restored: 1 });
    await waitFor(async () => (await statusCounts()).sent === 1);
    expect(mailer.sent).toHaveLength(1);
  });

  it('retries a transient SMTP failure and then sends once', async () => {
    const { user, sender } = await createUserWithSender();
    const mailer = new FakeMailer();
    mailer.failNext = 1;
    workers = [createEmailWorker(deps(mailer), 1)];
    await campaignService.create({
      userId: user.id, senderId: sender.id, subject: 'Hi', body: 'x',
      recipients: ['retry@example.com'], startAt: new Date(), delayBetweenMs: 0, hourlyLimit: 10, idempotencyKey: null,
    });
    await waitFor(async () => (await statusCounts()).sent === 1);
    const { rows } = await pool.query<{ attempts: number }>('SELECT attempts FROM emails');
    expect(rows[0]!.attempts).toBe(2);
    expect(mailer.sent).toHaveLength(1);
    // Shows the signed-in user as From, but relays through the sender's Ethereal account.
    expect(mailer.sent[0]).toMatchObject({
      from: '"Owner" <owner@example.com>',
      replyTo: 'owner@example.com',
      envelopeFrom: sender.email,
    });
  });

  /** Schedules one email and rewrites its row as if a worker died holding it. */
  async function interruptedEmail(smtpStarted: boolean) {
    const { user, sender } = await createUserWithSender();
    await campaignService.create({
      userId: user.id, senderId: sender.id, subject: 'Hi', body: 'x',
      recipients: ['crash@example.com'], startAt: new Date(Date.now() + 60_000), delayBetweenMs: 0, hourlyLimit: 10, idempotencyKey: null,
    });
    await pool.query(
      `UPDATE emails SET status = 'sending', claim_token = gen_random_uuid(), scheduled_at = now(),
         sending_started_at = now() - interval '10 minutes',
         smtp_started_at = CASE WHEN $1 THEN now() - interval '10 minutes' END`,
      [smtpStarted],
    );
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM emails');
    const id = rows[0]!.id;
    await emailQueue().remove(id);
    await emailQueue().add('send-email', { emailId: id }, { jobId: id });
    return id;
  }

  it('fails, rather than resends, an email a crashed worker left in the middle of SMTP', async () => {
    const mailer = new FakeMailer();
    await interruptedEmail(true);
    workers = [createEmailWorker(deps(mailer, { leaseMs: 1_000 }), 1)];
    await waitFor(async () => (await statusCounts()).failed === 1);
    expect(mailer.sent).toHaveLength(0);
    const { rows } = await pool.query<{ last_error: string }>('SELECT last_error FROM emails');
    expect(rows[0]!.last_error).toMatch(/outcome unknown/);
  });

  it('sends, exactly once, an email a crashed worker left before SMTP started', async () => {
    const mailer = new FakeMailer();
    await interruptedEmail(false);
    workers = [createEmailWorker(deps(mailer, { leaseMs: 1_000 }), 1)];
    await waitFor(async () => (await statusCounts()).sent === 1);
    expect(mailer.sent).toHaveLength(1);
  });

  it('records as sent, without resending, an email SMTP accepted before the database write was lost', async () => {
    const mailer = new FakeMailer();
    const id = await interruptedEmail(true);
    await new DeliveryJournal(sharedRedis()).record(id, { messageId: `<${id}@outbox.local>`, previewUrl: null });
    workers = [createEmailWorker(deps(mailer, { leaseMs: 1_000 }), 1)];
    await waitFor(async () => (await statusCounts()).sent === 1);
    expect(mailer.sent).toHaveLength(0);
  });

  it('does not let a worker that lost its claim send', async () => {
    const { user, sender } = await createUserWithSender();
    await campaignService.create({
      userId: user.id, senderId: sender.id, subject: 'Hi', body: 'x',
      recipients: ['late@example.com'], startAt: new Date(), delayBetweenMs: 0, hourlyLimit: 10, idempotencyKey: null,
    });
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM emails');
    const id = rows[0]!.id;
    await emailQueue().remove(id);
    const { emailRepository } = await import('../src/repositories/emailRepository.js');
    const first = await emailRepository.claimForSending(id);
    // Recovery hands the row to someone else while the first worker is stalled.
    await pool.query(`UPDATE emails SET status = 'scheduled', claim_token = NULL WHERE id = $1`, [id]);
    const second = await emailRepository.claimForSending(id);
    expect(await emailRepository.beginSmtp(id, first!.claim_token!)).toBe(false);
    expect(await emailRepository.beginSmtp(id, second!.claim_token!)).toBe(true);
  });

  it('does not retry a send whose outcome is unknown, or one the server refused', async () => {
    const { user, sender } = await createUserWithSender();
    const mailer = new FakeMailer();
    mailer.failNext = 2;
    mailer.failKind = 'unknown';
    workers = [createEmailWorker(deps(mailer), 1)];
    await campaignService.create({
      userId: user.id, senderId: sender.id, subject: 'Hi', body: 'x',
      recipients: ['a@example.com'], startAt: new Date(), delayBetweenMs: 0, hourlyLimit: 10, idempotencyKey: null,
    });
    await waitFor(async () => (await statusCounts()).failed === 1);
    mailer.failKind = 'permanent';
    await campaignService.create({
      userId: user.id, senderId: sender.id, subject: 'Hi', body: 'x',
      recipients: ['b@example.com'], startAt: new Date(), delayBetweenMs: 0, hourlyLimit: 10, idempotencyKey: null,
    });
    await waitFor(async () => (await statusCounts()).failed === 2);
    await new Promise((r) => setTimeout(r, 300));
    const { rows } = await pool.query<{ attempts: number }>('SELECT attempts FROM emails');
    expect(rows.map((r) => r.attempts)).toEqual([1, 1]);
    expect(mailer.sent).toHaveLength(0);
  });

  it('keeps delayed jobs across a worker restart and restores jobs Redis lost', async () => {
    const { user, sender } = await createUserWithSender();
    const mailer = new FakeMailer();
    await campaignService.create({
      userId: user.id, senderId: sender.id, subject: 'Later', body: 'x',
      recipients: recipients(5), startAt: new Date(Date.now() + 1_500), delayBetweenMs: 0, hourlyLimit: 100, idempotencyKey: null,
    });
    // "Crash" the first worker before anything is due, then lose two jobs from Redis.
    const first = createEmailWorker(deps(mailer), 5);
    await first.close();
    const ids = (await pool.query<{ id: string }>('SELECT id FROM emails ORDER BY recipient')).rows.map((r) => r.id);
    await emailQueue().remove(ids[0]!);
    await emailQueue().remove(ids[1]!);
    expect(await emailQueue().getDelayedCount()).toBe(3);

    const restored = await reconcilePendingJobs();
    expect(restored).toEqual({ checked: 5, restored: 2 });
    // Running it again changes nothing: reconciliation is idempotent.
    expect((await reconcilePendingJobs()).restored).toBe(0);

    workers = [createEmailWorker(deps(mailer), 5)];
    await waitFor(async () => (await statusCounts()).sent === 5);
    expect(mailer.sent).toHaveLength(5);
  });

  it('cancelling a scheduled email stops it from sending', async () => {
    const { user, sender } = await createUserWithSender();
    const mailer = new FakeMailer();
    await campaignService.create({
      userId: user.id, senderId: sender.id, subject: 'Hi', body: 'x',
      recipients: ['keep@example.com', 'drop@example.com'], startAt: new Date(Date.now() + 500), delayBetweenMs: 0, hourlyLimit: 10, idempotencyKey: null,
    });
    const drop = (await pool.query<{ id: string }>(`SELECT id FROM emails WHERE recipient = 'drop@example.com'`)).rows[0]!;
    await emailService.cancel(user.id, drop.id);
    workers = [createEmailWorker(deps(mailer), 2)];
    await waitFor(async () => (await statusCounts()).sent === 1);
    expect(mailer.sent.map((m) => m.to)).toEqual(['keep@example.com']);
    expect((await statusCounts()).cancelled).toBe(1);
  });
});
