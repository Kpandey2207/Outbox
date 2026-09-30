import { Queue, type JobsOptions } from 'bullmq';
import { env } from '../config/env.js';
import type { EmailSendJobData } from '../models/types.js';
import { createRedis } from './connection.js';

const SEND_JOB_NAME = 'send-email';

let queue: Queue<EmailSendJobData> | null = null;

export function emailQueue(): Queue<EmailSendJobData> {
  queue ??= new Queue<EmailSendJobData>(env.QUEUE_NAME, {
    connection: createRedis(),
    defaultJobOptions: {
      attempts: env.JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: env.JOB_BACKOFF_MS },
      removeOnComplete: { age: 7 * 24 * 3600, count: 10_000 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  });
  return queue;
}

export async function closeEmailQueue(): Promise<void> {
  if (queue) {
    const q = queue;
    queue = null;
    await q.close();
  }
}

/**
 * The email row id doubles as the BullMQ job id. Adding a job whose id already exists
 * is a no-op in BullMQ, so enqueueing is idempotent: API retries and the boot-time
 * reconciliation can call this freely without ever creating a second job.
 */
export function sendJob(emailId: string, runAt: Date, now = Date.now()) {
  const opts: JobsOptions = { jobId: emailId, delay: Math.max(0, runAt.getTime() - now) };
  return { name: SEND_JOB_NAME, data: { emailId }, opts };
}

export async function enqueueEmails(emails: { id: string; scheduled_at: Date }[]): Promise<void> {
  const now = Date.now();
  const chunk = 500;
  for (let i = 0; i < emails.length; i += chunk) {
    await emailQueue().addBulk(emails.slice(i, i + chunk).map((e) => sendJob(e.id, e.scheduled_at, now)));
  }
}
