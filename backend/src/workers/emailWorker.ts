import { Worker } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { redactSecrets, safeError } from '../utils/errors.js';
import { SmtpMailer, type Mailer } from '../integrations/mailer.js';
import type { EmailSendJobData } from '../models/types.js';
import { createRedis, sharedRedis } from '../queue/connection.js';
import { DeliveryJournal } from '../queue/deliveryJournal.js';
import { RateLimiter } from '../queue/rateLimiter.js';
import { notificationService } from '../services/notificationService.js';
import { createEmailProcessor, type ProcessOutcome, type ProcessorDeps } from './emailProcessor.js';
import { markQueueEpoch, reconcilePendingJobs, startWatchdog } from './reconcile.js';

export function defaultProcessorDeps(mailer: Mailer = new SmtpMailer()): ProcessorDeps {
  return {
    mailer,
    limiter: new RateLimiter(sharedRedis()),
    journal: new DeliveryJournal(sharedRedis()),
    notifier: notificationService,
    maxPerSenderPerHour: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
    globalHourlyLimit: env.MAX_EMAILS_PER_HOUR_GLOBAL,
    minDelayMs: env.MIN_DELAY_BETWEEN_SENDS_MS,
    leaseMs: env.SEND_LEASE_MS,
  };
}

export function createEmailWorker(deps: ProcessorDeps, concurrency = env.WORKER_CONCURRENCY) {
  const worker = new Worker<EmailSendJobData, ProcessOutcome>(env.QUEUE_NAME, createEmailProcessor(deps), {
    connection: createRedis(),
    concurrency,
    // Redelivery is always safe (the claim token and smtp_started_at decide what may happen),
    // so a job is allowed to survive several worker crashes over its life.
    maxStalledCount: 5,
    stalledInterval: 30_000,
  });
  worker.on('failed', (job, err) =>
    logger.warn({ jobId: job?.id, attemptsMade: job?.attemptsMade, err: redactSecrets(err.message) }, 'job failed'),
  );
  worker.on('error', (err) => logger.error({ err: safeError(err) }, 'worker error'));
  return worker;
}

/**
 * Restores jobs missing from Redis, then starts the watchdog and the worker. close() stops
 * taking jobs and waits for the ones in flight.
 */
export async function startEmailWorker(): Promise<{ close: () => Promise<void> }> {
  await reconcilePendingJobs();
  await markQueueEpoch();
  const stopWatchdog = startWatchdog();
  const mailer = new SmtpMailer();
  const worker = createEmailWorker(defaultProcessorDeps(mailer));
  return {
    close: async () => {
      stopWatchdog();
      await worker.close();
      mailer.close();
    },
  };
}
