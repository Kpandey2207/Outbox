import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    // Integration tests share one Postgres database and one Redis db, so run files serially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://outbox:outbox@localhost:5432/outbox_test',
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15',
      QUEUE_NAME: 'email-send-test',
      ETHEREAL_USER: 'test-sender@ethereal.email',
      ETHEREAL_PASS: 'test-pass',
      MIN_DELAY_BETWEEN_SENDS_MS: '0',
      JOB_BACKOFF_MS: '50',
      DEV_LOGIN_ENABLED: 'true',
      // Tests talk plain http; a Secure cookie (as used behind an https tunnel) would never be sent back.
      COOKIE_SECURE: 'false',
      // Request limits have their own test, which switches them on.
      RATE_LIMIT_ENABLED: 'false',
      // Pin everything a developer's .env might override, so tests behave the same everywhere.
      MAX_EMAILS_PER_HOUR_PER_SENDER: '10000',
      MAX_EMAILS_PER_HOUR_GLOBAL: '10000',
      ELASTICSEARCH_URL: '',
      API_URL: 'http://localhost:3000',
      FRONTEND_URL: 'http://localhost:3000',
      QUEUE_ADMIN_EMAILS: '',
      TRUST_PROXY: '',
      GOOGLE_CLIENT_ID: '',
      SLACK_CLIENT_ID: '',
      WORKER_CONCURRENCY: '5',
      JOB_ATTEMPTS: '3',
    },
  },
});
