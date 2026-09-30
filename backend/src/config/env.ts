import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  PORT: z.coerce.number().int().positive().default(4000),

  API_URL: z.string().url().default('http://localhost:4000'),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().default('postgres://outbox:outbox@localhost:5432/outbox'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  /** Signs OAuth `state`. Also the fallback source for DATA_ENCRYPTION_KEY. */
  JWT_SECRET: z.string().min(16).default('dev-only-secret-change-me-please'),
  /**
   * 32-byte key (base64 or hex) that encrypts Slack tokens and SMTP passwords at rest.
   * When unset, a key is derived from JWT_SECRET, so rotating JWT_SECRET needs this set first.
   */
  DATA_ENCRYPTION_KEY: optionalString,
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24 * 7),
  /** Secure cookies. Defaults to on in production; set false only for plain-http setups. */
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v === 'true' || v === '1')),
  /**
   * Emails allowed into Bull Board, comma separated, or `*` for every signed-in user (a
   * local demo). Unset: everyone on a localhost development setup, nobody otherwise.
   */
  QUEUE_ADMIN_EMAILS: optionalString,
  /**
   * Which proxy hops may set X-Forwarded-For (Express "trust proxy"). Off by default, so a
   * client cannot pick its own IP for the per-IP limits. Behind a platform edge that sets
   * the header (Render, Railway, Vercel) use the number of proxies in front of the API.
   */
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v): boolean | number | string => {
      const t = v?.trim() ?? '';
      if (t === '' || t === 'false' || t === '0') return false;
      if (t === 'true') return true;
      return /^\d+$/.test(t) ? Number(t) : t;
    }),
  /** Per-IP and per-user request limits on auth and write endpoints. */
  RATE_LIMIT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),

  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  /** Local-only shortcut that signs in a fixed demo user. Never enable in production. */
  DEV_LOGIN_ENABLED: bool,

  SLACK_CLIENT_ID: optionalString,
  SLACK_CLIENT_SECRET: optionalString,

  ELASTICSEARCH_URL: optionalString,
  /** For secured clusters such as Elastic Cloud. Credentials in the URL also work. */
  ELASTICSEARCH_API_KEY: optionalString,
  ELASTICSEARCH_INDEX: z.string().default('emails'),

  SMTP_HOST: z.string().default('smtp.ethereal.email'),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: bool,
  /** Optional fixed Ethereal account; otherwise one is created per sender. */
  ETHEREAL_USER: optionalString,
  ETHEREAL_PASS: optionalString,

  QUEUE_NAME: z.string().default('email-send'),
  /**
   * Also run the email worker inside the API process. For single-instance free hosting;
   * normally the worker is its own process (`node dist/worker.js`) so it scales separately.
   */
  RUN_WORKER_IN_API: bool,
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),
  JOB_BACKOFF_MS: z.coerce.number().int().nonnegative().default(30_000),

  /** Floor for the delay between two sends from the same sender, in ms. */
  MIN_DELAY_BETWEEN_SENDS_MS: z.coerce.number().int().nonnegative().default(1_000),
  /** Hard ceiling per sender per hour; a campaign may only ask for less. */
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().positive().default(200),
  /** Ceiling across every sender per hour. */
  MAX_EMAILS_PER_HOUR_GLOBAL: z.coerce.number().int().positive().default(1_000),
  /** How long a row may stay in `sending` before it is treated as interrupted. */
  SEND_LEASE_MS: z.coerce.number().int().positive().default(120_000),

  /** Per-file and per-email attachment caps. Every email in a campaign carries the files. */
  MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  MAX_ATTACHMENTS_PER_EMAIL: z.coerce.number().int().positive().default(5),
  MAX_ATTACHMENTS_TOTAL_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  /** Uploaded but not yet scheduled files, per user. */
  MAX_PENDING_UPLOADS: z.coerce.number().int().positive().default(20),

  MAX_RECIPIENTS_PER_CAMPAIGN: z.coerce.number().int().positive().default(10_000),
  /** Scheduled (not yet sent) emails one user may have at a time, across campaigns. */
  MAX_SCHEDULED_PER_USER: z.coerce.number().int().positive().default(50_000),
  /** Body bytes x recipients. Each email row stores its own copy of the body. */
  MAX_CAMPAIGN_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
});

type Parsed = z.infer<typeof schema>;
export type Env = Omit<Parsed, 'COOKIE_SECURE' | 'QUEUE_ADMIN_EMAILS'> & {
  COOKIE_SECURE: boolean;
  QUEUE_ADMIN_EMAILS: string[] | undefined;
};

export function isLocalOrigin(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const data = parsed.data;
  const production = data.NODE_ENV === 'production';
  if (production) {
    if (data.DEV_LOGIN_ENABLED) throw new Error('DEV_LOGIN_ENABLED must be false in production');
    if (data.JWT_SECRET.startsWith('dev-only') || data.JWT_SECRET.startsWith('change-me') || data.JWT_SECRET.length < 32) {
      throw new Error(
        'JWT_SECRET must be a random string of at least 32 characters in production. Generate one with: openssl rand -hex 32',
      );
    }
  }
  // The demo login signs anyone in as the same user; it is for a machine nobody else can reach.
  if (data.DEV_LOGIN_ENABLED && !isLocalOrigin(data.FRONTEND_URL)) {
    throw new Error('DEV_LOGIN_ENABLED only works when FRONTEND_URL is a localhost address');
  }
  return {
    ...data,
    COOKIE_SECURE: data.COOKIE_SECURE ?? production,
    QUEUE_ADMIN_EMAILS: data.QUEUE_ADMIN_EMAILS?.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  };
}

export const env = loadEnv();
