import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { sharedRedis } from '../queue/connection.js';
import { emailQueue, sendJob } from '../queue/emailQueue.js';
import { emailRepository } from '../repositories/emailRepository.js';
import type { Email } from '../models/types.js';
import { safeError } from '../utils/errors.js';

/** Makes sure one pending row has a live job. Returns true if a job had to be (re)added. */
async function ensureJob(row: Email): Promise<boolean> {
  const queue = emailQueue();
  const job = await queue.getJob(row.id);
  if (job) {
    const state = await job.getState();
    if (state !== 'completed' && state !== 'failed' && state !== 'unknown') return false;
    // The row is pending but its job already finished or gave up: replace it.
    await job.remove();
  }
  const { name, data, opts } = sendJob(row.id, new Date(row.scheduled_at));
  await queue.add(name, data, opts);
  return true;
}

/**
 * Runs when a worker boots. Postgres says which emails are still pending; this makes sure
 * each one has a live BullMQ job. With Redis persistence on, this finds nothing to do. It
 * matters when Redis lost data, or when the API crashed between committing a campaign and
 * enqueueing its jobs. Existing jobs are left untouched, so their timing is preserved.
 */
export async function reconcilePendingJobs(batchSize = 500): Promise<{ checked: number; restored: number }> {
  let afterId: string | null = null;
  let checked = 0;
  let restored = 0;
  for (;;) {
    const rows = await emailRepository.pendingPage(afterId, batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      checked++;
      if (await ensureJob(row)) restored++;
    }
    afterId = rows[rows.length - 1]!.id;
  }
  if (restored > 0) logger.warn({ checked, restored }, 'restored missing jobs from postgres');
  else logger.info({ checked }, 'queue matches postgres; nothing to restore');
  return { checked, restored };
}

const EPOCH_KEY = 'outbox:queue-epoch';
const SWEEP_LOCK = 'outbox:watchdog-lock';

/**
 * The watchdog: a safety net, not the scheduler (BullMQ delayed jobs are). Every minute one
 * worker, chosen by a Redis lock, checks two things while processes keep running:
 *
 *  1. Did Redis lose its data (restart without persistence, FLUSHALL)? A marker key written
 *     at boot disappears with it; if it is gone, run the full boot reconciliation now
 *     instead of waiting for someone to restart a process.
 *  2. Is any row overdue with no live job? That happens when BullMQ gave up on a job (a long
 *     Postgres outage used up its attempts, a job stalled too often) while the row still
 *     says `scheduled` or `sending`. Such rows get a fresh job; the claim and the
 *     smtp_started_at mark still decide safely whether sending is allowed.
 */
export async function watchdogSweep(graceMs = 2 * 60_000, batch = 500): Promise<{ full: boolean; restored: number }> {
  const redis = sharedRedis();
  const lock = await redis.set(SWEEP_LOCK, String(process.pid), 'PX', 50_000, 'NX');
  if (lock !== 'OK') return { full: false, restored: 0 };
  if (!(await redis.exists(EPOCH_KEY))) {
    logger.warn('queue marker missing: Redis lost data; reconciling every pending email');
    const { restored } = await reconcilePendingJobs();
    await markQueueEpoch();
    return { full: true, restored };
  }
  let restored = 0;
  for (const row of await emailRepository.strandedPage(graceMs, env.SEND_LEASE_MS, batch)) {
    if (await ensureJob(row)) restored++;
  }
  if (restored > 0) logger.warn({ restored }, 'watchdog re-queued overdue emails that had no live job');
  return { full: false, restored };
}

export async function markQueueEpoch(): Promise<void> {
  await sharedRedis().set(EPOCH_KEY, new Date().toISOString());
}

/** Runs the watchdog every `intervalMs` in this process; returns a stop function. */
export function startWatchdog(intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    watchdogSweep().catch((err) => logger.warn({ err: safeError(err) }, 'watchdog sweep failed'));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
