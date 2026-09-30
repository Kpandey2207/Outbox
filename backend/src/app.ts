import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { stdSerializers } from 'pino';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { pool } from './db/pool.js';
import { requireAuth, requireQueueAdmin } from './middleware/auth.js';
import { sameOriginWrites } from './middleware/security.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { BULL_BOARD_PATH, bullBoardRouter } from './queue/bullBoard.js';
import { sharedRedis } from './queue/connection.js';
import { apiRoutes, authRoutes } from './routes/index.js';

export function createApp() {
  const app = express();
  // Whose X-Forwarded-For to believe for req.ip (the per-IP limits). See TRUST_PROXY.
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' },
      // OAuth callbacks carry a one-time `code` and `state` in the query string; keep them out.
      serializers: {
        req: stdSerializers.wrapRequestSerializer((r) => ({ ...r, url: r.url?.split('?')[0] })),
      },
    }),
  );
  // One exact origin, never `*`: the dashboard normally calls through same-origin rewrites,
  // and this only matters if it is ever served from a separate origin.
  app.use(cors({ origin: new URL(env.FRONTEND_URL).origin, credentials: true }));
  app.use(cookieParser());
  app.use(sameOriginWrites());
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', async (_req, res) => {
    const [db, redis] = await Promise.allSettled([pool.query('SELECT 1'), sharedRedis().ping()]);
    const ok = db.status === 'fulfilled' && redis.status === 'fulfilled';
    res.status(ok ? 200 : 503).json({ ok, db: db.status, redis: redis.status });
  });

  // Bull Board serves its own inline UI, so it is mounted before helmet's strict CSP. It is
  // still frame-protected and operator-only (it sees every user's jobs).
  app.use(BULL_BOARD_PATH, helmet({ contentSecurityPolicy: false }), requireAuth, requireQueueAdmin, bullBoardRouter());

  app.use(helmet());
  app.use(authRoutes());
  app.use('/api', apiRoutes());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
