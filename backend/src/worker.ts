import { logger } from './config/logger.js';
import { safeError } from './utils/errors.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { closeEmailQueue } from './queue/emailQueue.js';
import { closeSharedRedis } from './queue/connection.js';
import { startEmailWorker } from './workers/emailWorker.js';
import { env } from './config/env.js';

async function main() {
  // Safe to run from every process: an advisory lock serialises concurrent boots.
  await migrate();
  const worker = await startEmailWorker();
  logger.info({ concurrency: env.WORKER_CONCURRENCY, queue: env.QUEUE_NAME }, 'email worker started');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker shutting down; finishing active jobs');
    // Waits for in-flight jobs, so a normal deploy never leaves rows in `sending`.
    await worker.close();
    await closeEmailQueue();
    await closeSharedRedis();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err: safeError(err) }, 'worker failed to start');
  process.exit(1);
});
