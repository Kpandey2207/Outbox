import { pino } from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  // Last line of defence; third-party errors are also reduced with safeError() before logging.
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["idempotency-key"]',
      'res.headers["set-cookie"]',
      '*.smtp_pass',
      '*.smtpPass',
      '*.bot_token',
      '*.botToken',
      '*.password',
      '*.password_hash',
      '*.client_secret',
      '*.access_token',
      '*.token',
    ],
    censor: '[redacted]',
  },
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } } }
    : {}),
});
