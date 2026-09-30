import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { safeError } from './utils/errors.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';
import { closeEmailQueue } from './queue/emailQueue.js';
import { closeSharedRedis } from './queue/connection.js';
import { startEmailWorker } from './workers/emailWorker.js';

async function main() {
  await migrate();
  const server = createApp().listen(env.PORT, () => logger.info({ port: env.PORT }, 'api listening'));

  let embedded: { close: () => Promise<void> } | null = null;
  if (env.RUN_WORKER_IN_API) {
    embedded = await startEmailWorker();
    logger.info({ concurrency: env.WORKER_CONCURRENCY }, 'email worker running inside the api process');
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'api shutting down');
    // Hard deadline, in case a connection or job never finishes.
    setTimeout(() => process.exit(1), 50_000).unref();
    const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    // The embedded worker stops taking jobs right away and finishes the ones in flight,
    // in parallel with HTTP draining, so a send is never cut off by a slow client.
    await Promise.all([httpClosed, embedded?.close()]);
    await closeEmailQueue();
    await closeSharedRedis();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err: safeError(err) }, 'api failed to start');
  process.exit(1);
});
