import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { env, loadEnv } from '../src/config/env.js';
import { postToInstall } from '../src/integrations/slack.js';
import type { Email } from '../src/models/types.js';
import { emailQueue } from '../src/queue/emailQueue.js';
import { inView } from '../src/repositories/emailRepository.js';
import { pool } from '../src/db/pool.js';
import { classifySmtpError } from '../src/integrations/mailer.js';
import { closeSharedRedis } from '../src/queue/connection.js';
import { closeEmailQueue } from '../src/queue/emailQueue.js';
import { senderRepository } from '../src/repositories/senderRepository.js';
import { slackRepository } from '../src/repositories/slackRepository.js';
import { authService } from '../src/services/authService.js';
import { redactSecrets, safeError } from '../src/utils/errors.js';
import { resetState } from './helpers.js';

const app = createApp();

async function signUp(email: string) {
  const agent = request.agent(app);
  await agent.post('/auth/email').send({ email, password: 'a long password' }).expect(201);
  const me = await agent.get('/api/me').expect(200);
  return { agent, userId: me.body.user.id as string, senderId: me.body.senders[0].id as string };
}

const campaign = (senderId: string, extra: Record<string, unknown> = {}) => ({
  senderId,
  subject: 'Hello',
  body: '<p>Hi</p>',
  recipients: ['ann@example.com'],
  startAt: new Date(Date.now() + 3_600_000).toISOString(),
  delayBetweenSeconds: 2,
  hourlyLimit: 50,
  ...extra,
});

const sessionCookie = (res: request.Response) =>
  ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('outbox_session='))!.split(';')[0]!;

afterAll(async () => {
  await closeEmailQueue();
  await closeSharedRedis();
  await pool.end();
});

describe('security', () => {
  const saved = { ...env };

  beforeEach(async () => {
    await resetState();
  });

  afterEach(() => {
    Object.assign(env, saved);
  });

  it("never serves or changes another user's emails, attachments or senders", async () => {
    const alice = await signUp('alice@example.com');
    const mallory = await signUp('mallory@example.com');
    await alice.agent.post('/api/campaigns').send(campaign(alice.senderId)).expect(201);
    const emailId = (await alice.agent.get('/api/emails').expect(200)).body.items[0].id as string;
    const up = await alice.agent.post('/api/attachments').attach('files', Buffer.from('hi'), 'a.txt').expect(201);
    const attachmentId = up.body.items[0].id as string;

    await mallory.agent.get(`/api/emails/${emailId}`).expect(404);
    await mallory.agent.patch(`/api/emails/${emailId}`).send({ starred: true }).expect(404);
    await mallory.agent.delete(`/api/emails/${emailId}`).expect(404);
    await mallory.agent.get(`/api/attachments/${attachmentId}`).expect(404);
    await mallory.agent.delete(`/api/attachments/${attachmentId}`).expect(404);
    // Scheduling with someone else's sender or files is refused too.
    await mallory.agent.post('/api/campaigns').send(campaign(alice.senderId)).expect(404);
    await mallory.agent.post('/api/campaigns').send(campaign(mallory.senderId, { attachmentIds: [attachmentId] })).expect(400);
    // Lists, counts and search only ever show the caller's own mail.
    expect((await mallory.agent.get('/api/emails').expect(200)).body.total).toBe(0);
    expect((await mallory.agent.get('/api/emails?q=hello').expect(200)).body.total).toBe(0);
    expect((await mallory.agent.get('/api/emails/counts').expect(200)).body.scheduled).toBe(0);

    const { rows } = await pool.query('SELECT starred, deleted_at FROM emails WHERE id = $1', [emailId]);
    expect(rows[0]).toEqual({ starred: false, deleted_at: null });
  });

  it('ends the session on the server at logout, so a copied cookie stops working', async () => {
    const res = await request(app).post('/auth/email').send({ email: 'bob@example.com', password: 'a long password' }).expect(201);
    const cookie = sessionCookie(res);
    expect(res.headers['set-cookie']!.toString()).toMatch(/HttpOnly/);
    expect(res.headers['set-cookie']!.toString()).toMatch(/SameSite=Lax/);
    await request(app).get('/api/me').set('Cookie', cookie).expect(200);
    await request(app).post('/auth/logout').set('Cookie', cookie).expect(204);
    await request(app).get('/api/me').set('Cookie', cookie).expect(401);
    // Forged or malformed tokens are just unauthenticated.
    await request(app).get('/api/me').set('Cookie', 'outbox_session=not-a-real-token').expect(401);
  });

  it('only stores a hash of the session token', async () => {
    const res = await request(app).post('/auth/email').send({ email: 'hash@example.com', password: 'a long password' }).expect(201);
    const token = sessionCookie(res).split('=')[1]!;
    const { rows } = await pool.query<{ token_hash: Buffer }>('SELECT token_hash FROM sessions');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash.toString('base64url')).not.toBe(token);
  });

  it('lets a verified Google sign in take back an email someone registered with a password', async () => {
    const squatter = await request(app).post('/auth/email').send({ email: 'victim@example.com', password: 'squatters pass' }).expect(201);
    const cookie = sessionCookie(squatter);
    await authService.signIn({ googleId: 'google-123', email: 'victim@example.com', name: 'Victim', avatarUrl: null });
    // The squatter's session is gone and their password no longer works.
    await request(app).get('/api/me').set('Cookie', cookie).expect(401);
    await request(app).post('/auth/email').send({ email: 'victim@example.com', password: 'squatters pass' }).expect(409);
  });

  it('refuses state-changing requests from other sites', async () => {
    const { agent, senderId } = await signUp('csrf@example.com');
    await agent.post('/api/campaigns').set('Origin', 'https://evil.example').send(campaign(senderId)).expect(403);
    await agent.post('/api/campaigns').set('Sec-Fetch-Site', 'cross-site').send(campaign(senderId)).expect(403);
    await agent.post('/api/campaigns').set('Referer', 'https://evil.example/page').send(campaign(senderId)).expect(403);
    await agent.post('/auth/logout').set('Origin', 'https://evil.example').expect(403);
    await agent.post('/api/campaigns').set('Origin', env.FRONTEND_URL).send(campaign(senderId)).expect(201);
    // Reads are unaffected.
    await agent.get('/api/me').set('Origin', 'https://evil.example').expect(200);
  });

  it('allows only the configured frontend origin for CORS, never a wildcard', async () => {
    const evil = await request(app).get('/auth/config').set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).not.toBe('https://evil.example');
    expect(evil.headers['access-control-allow-origin']).not.toBe('*');
    const ok = await request(app).get('/auth/config').set('Origin', new URL(env.FRONTEND_URL).origin);
    expect(ok.headers['access-control-allow-origin']).toBe(new URL(env.FRONTEND_URL).origin);
  });

  it('rate limits sign in attempts per client', async () => {
    env.RATE_LIMIT_ENABLED = true;
    const tries = [];
    for (let i = 0; i < 21; i++) {
      tries.push(await request(app).post('/auth/email').send({ email: `u${i}@example.com`, password: 'x' }));
    }
    expect(tries.slice(0, 20).every((r) => r.status === 400)).toBe(true);
    expect(tries[20]!.status).toBe(429);
    expect(tries[20]!.headers['retry-after']).toBeDefined();
  });

  it('keeps Bull Board to operators', async () => {
    const { agent } = await signUp('ops@example.com');
    env.QUEUE_ADMIN_EMAILS = ['someone-else@example.com'];
    await agent.get('/admin/queues').expect(403);
    expect((await agent.get('/api/me').expect(200)).body.features.queueDashboard).toBe(false);
    env.QUEUE_ADMIN_EMAILS = ['ops@example.com'];
    await agent.get('/admin/queues').expect(200);
    await request(app).get('/admin/queues').expect(401);
  });

  it('encrypts Slack tokens and SMTP passwords at rest and never returns them', async () => {
    const { agent, userId } = await signUp('crypt@example.com');
    await slackRepository.upsert({
      user_id: userId, team_id: 'T1', team_name: 'Team', bot_token: 'xoxb-secret-token', channel_id: 'C1', channel_name: 'alerts',
      webhook_url: 'https://hooks.slack.com/services/T1/B1/secret',
    });
    const raw = await pool.query<{ bot_token: string; webhook_url: string }>('SELECT bot_token, webhook_url FROM slack_installations');
    expect(raw.rows[0]!.bot_token).toMatch(/^enc:v1:/);
    expect(raw.rows[0]!.webhook_url).toMatch(/^enc:v1:/);
    expect((await slackRepository.findByUser(userId))!.webhook_url).toBe('https://hooks.slack.com/services/T1/B1/secret');
    expect((await slackRepository.findByUser(userId))!.bot_token).toBe('xoxb-secret-token');
    const senders = await pool.query<{ id: string; smtp_pass: string }>('SELECT id, smtp_pass FROM senders');
    expect(senders.rows[0]!.smtp_pass).toMatch(/^enc:v1:/);
    expect((await senderRepository.findById(senders.rows[0]!.id))!.smtp_pass).toBe(env.ETHEREAL_PASS);

    const me = await agent.get('/api/me').expect(200);
    const body = JSON.stringify(me.body);
    expect(body).not.toContain('xoxb');
    expect(body).not.toContain('hooks.slack.com');
    expect(body).not.toContain('smtp');
    expect(body).not.toContain(env.ETHEREAL_PASS!);
  });

  it('rejects files whose content does not match their extension', async () => {
    const { agent } = await signUp('files@example.com');
    const res = await agent.post('/api/attachments').attach('files', Buffer.from('<html><script>alert(1)</script>'), 'cat.png').expect(400);
    expect(res.body.error.message).toMatch(/does not look like a PNG/);
    await agent.post('/api/attachments').attach('files', Buffer.from('not a pdf'), 'x.pdf').expect(400);
    await agent.post('/api/leads/parse').attach('file', Buffer.from([0x00, 0x01, 0x02]), 'leads.csv').expect(400);
  });

  it('bounds dates, paging, idempotency keys and campaign size', async () => {
    const { agent, senderId } = await signUp('bounds@example.com');
    const farFuture = new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString();
    await agent.post('/api/campaigns').send(campaign(senderId, { startAt: farFuture })).expect(400);
    await agent.get('/api/emails?page=100000').expect(400);
    await agent.get('/api/emails?pageSize=5000').expect(400);
    await agent.post('/api/campaigns').set('Idempotency-Key', 'bad key with spaces').send(campaign(senderId)).expect(400);
    env.MAX_CAMPAIGN_BYTES = 1000;
    const res = await agent
      .post('/api/campaigns')
      .send(campaign(senderId, { body: 'x'.repeat(600), recipients: ['a@example.com', 'b@example.com'] }))
      .expect(400);
    expect(res.body.error.message).toMatch(/too large/);
  });

  it('never answers with internals when something unexpected fails', async () => {
    const { agent } = await signUp('errors@example.com');
    const res = await agent.post('/api/campaigns').set('Content-Type', 'application/json').send('{"broken"').expect(400);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|at .*\.ts|postgres:\/\//);
  });

  it('keeps credentials out of logged errors', () => {
    expect(redactSecrets('connect to postgres://outbox:hunter2@db:5432 failed')).not.toContain('hunter2');
    expect(redactSecrets('token xoxb-123-456-abc was revoked')).not.toContain('xoxb-123');
    const leaky = Object.assign(new Error('request failed'), { config: { data: 'client_secret=shh' } });
    expect(JSON.stringify(safeError(leaky))).not.toContain('shh');
  });
});

describe('hostile review fixes', () => {
  const saved = { ...env };

  beforeEach(async () => {
    await resetState();
  });

  afterEach(() => {
    Object.assign(env, saved);
    vi.restoreAllMocks();
  });

  it('ignores a client-supplied X-Forwarded-For, so per-IP limits cannot be dodged', async () => {
    env.RATE_LIMIT_ENABLED = true;
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await request(app).post('/auth/email').set('X-Forwarded-For', `6.6.6.${i}`).send({ email: `x${i}@example.com`, password: 'x' });
      statuses.push(res.status);
    }
    expect(statuses[20]).toBe(429);
  });

  it('locks password guessing per client, so a stranger cannot lock the owner out', async () => {
    await authService.emailSignIn('owner@example.com', 'the right password', '10.0.0.1');
    for (let i = 0; i < 10; i++) {
      await expect(authService.emailSignIn('owner@example.com', 'wrong guess!', '6.6.6.6')).rejects.toMatchObject({ status: 401 });
    }
    await expect(authService.emailSignIn('owner@example.com', 'wrong guess!', '6.6.6.6')).rejects.toMatchObject({ status: 429 });
    // The owner, from their own address, still gets in.
    await expect(authService.emailSignIn('owner@example.com', 'the right password', '10.0.0.1')).resolves.toMatchObject({ created: false });
  });

  it("undoes a squatter's setup when the owner proves the address with Google", async () => {
    const squatter = await signUp('victim@example.com');
    await squatter.agent.post('/api/campaigns').send(campaign(squatter.senderId)).expect(201);
    await squatter.agent.post('/api/attachments').attach('files', Buffer.from('hi'), 'a.txt').expect(201);
    await slackRepository.upsert({
      user_id: squatter.userId, team_id: 'T', team_name: 'Evil', bot_token: 'xoxb-evil', channel_id: 'C', channel_name: 'c', webhook_url: null,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}'));

    await authService.signIn({ googleId: 'google-owner', email: 'victim@example.com', name: 'Victim', avatarUrl: null });

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM emails');
    expect(rows.map((r) => r.status)).toEqual(['cancelled']);
    expect(await slackRepository.findByUser(squatter.userId)).toBeNull();
    expect((await pool.query('SELECT 1 FROM attachments')).rowCount).toBe(0);
    expect(await emailQueue().getJobCounts('delayed')).toMatchObject({ delayed: 0 });
  });

  it('refuses a different Google account for an email already bound to one', async () => {
    await authService.signIn({ googleId: 'google-1', email: 'bound@example.com', name: null, avatarUrl: null });
    await expect(
      authService.signIn({ googleId: 'google-2', email: 'bound@example.com', name: null, avatarUrl: null }),
    ).rejects.toMatchObject({ code: 'google_account_mismatch' });
  });

  it('opens Bull Board to everyone only when asked to with *', async () => {
    const { agent } = await signUp('guest@example.com');
    env.NODE_ENV = 'production';
    env.QUEUE_ADMIN_EMAILS = undefined;
    await agent.get('/admin/queues').expect(403);
    env.QUEUE_ADMIN_EMAILS = ['*'];
    await agent.get('/admin/queues').expect(200);
    // A dev server exposed through a tunnel does not open it by default.
    env.NODE_ENV = 'development';
    env.QUEUE_ADMIN_EMAILS = undefined;
    env.FRONTEND_URL = 'https://abc.ngrok-free.app';
    await agent.get('/admin/queues').expect(403);
  });

  it('refuses the demo login on anything but localhost', () => {
    const base = { NODE_ENV: 'development', DEV_LOGIN_ENABLED: 'true' };
    expect(() => loadEnv({ ...base, FRONTEND_URL: 'https://abc.ngrok-free.app' })).toThrow(/localhost/);
    expect(() => loadEnv({ ...base, FRONTEND_URL: 'http://localhost:3000' })).not.toThrow();
    expect(() => loadEnv({ NODE_ENV: 'production', JWT_SECRET: 'change-me-to-a-long-random-string' })).toThrow(/openssl rand/);
  });

  it('refuses a reused Idempotency-Key with different content, and fills in lost jobs on replay', async () => {
    const { agent, senderId } = await signUp('idem@example.com');
    const first = await agent.post('/api/campaigns').set('Idempotency-Key', 'k1').send(campaign(senderId)).expect(201);
    const edited = await agent.post('/api/campaigns').set('Idempotency-Key', 'k1').send(campaign(senderId, { subject: 'Changed' })).expect(422);
    expect(edited.body.error.code).toBe('idempotency_key_reused');

    // The first request's jobs were lost (say the process died before enqueueing).
    await emailQueue().obliterate({ force: true });
    const again = await agent.post('/api/campaigns').set('Idempotency-Key', 'k1').send(campaign(senderId)).expect(200);
    expect(again.body).toMatchObject({ campaignId: first.body.campaignId, replayed: true });
    expect((await emailQueue().getJobCounts('delayed')).delayed).toBe(1);
  });

  it('refuses an empty body and names the invalid recipients', async () => {
    const { agent, senderId } = await signUp('empty@example.com');
    for (const body of ['<p><br></p>', '<p>&nbsp;</p>', '<div> </div>']) {
      await agent.post('/api/campaigns').send(campaign(senderId, { body })).expect(400);
    }
    await agent.post('/api/campaigns').send(campaign(senderId, { body: '<p><img src="https://example.com/a.png"></p>' })).expect(201);
    const bad = await agent.post('/api/campaigns').send(campaign(senderId, { recipients: ['ok@example.com', 'a[1]@x.com'] })).expect(400);
    expect(bad.body.error.message).toContain('a[1]@x.com');
  });

  it('holds the pending-upload cap under parallel uploads', async () => {
    const { agent } = await signUp('uploads@example.com');
    env.MAX_PENDING_UPLOADS = 5;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => agent.post('/api/attachments').attach('files', Buffer.from(`f${i}`), `f${i}.txt`)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect((await pool.query('SELECT 1 FROM attachments')).rowCount).toBe(5);
  });

  it('caps how much unsent mail one account can queue', async () => {
    const { agent, senderId } = await signUp('cap@example.com');
    env.MAX_SCHEDULED_PER_USER = 3;
    await agent.post('/api/campaigns').send(campaign(senderId, { recipients: ['a@example.com', 'b@example.com'] })).expect(201);
    const res = await agent.post('/api/campaigns').send(campaign(senderId, { recipients: ['c@example.com', 'd@example.com'] })).expect(400);
    expect(res.body.error.message).toMatch(/up to 3 emails waiting/);
  });

  it('sends a Slack callback that lost its session to sign in, not to a JSON error', async () => {
    const res = await request(app).get('/integrations/slack/callback?code=x&state=y').expect(302);
    expect(res.headers.location).toBe(new URL('/login?error=slack_signed_out', env.FRONTEND_URL).toString());
  });

  it("posts alerts through the install's webhook, which works without inviting the bot", async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    await postToInstall({ bot_token: 'xoxb-x', channel_id: 'C1', webhook_url: 'https://hooks.slack.com/services/A/B/C' }, 'hi');
    expect(fetchMock).toHaveBeenCalledWith('https://hooks.slack.com/services/A/B/C', expect.objectContaining({ method: 'POST' }));
    fetchMock.mockResolvedValue(new Response('channel_is_archived', { status: 410 }));
    await expect(postToInstall({ bot_token: 'x', channel_id: 'C', webhook_url: 'https://hooks.slack.com/x' }, 'hi')).rejects.toMatchObject({
      slackCode: 'channel_is_archived',
    });
  });

  it('says which limit an oversized upload broke', async () => {
    const { agent } = await signUp('big@example.com');
    const res = await agent.post('/api/leads/parse').attach('file', Buffer.alloc(3 * 1024 * 1024, 'a'), 'leads.csv').expect(400);
    expect(res.body.error.message).toMatch(/list is larger than 2 MB/);
  });

  it('drops search hits that have since left the view', () => {
    const base = { status: 'sent', deleted_at: null, archived_at: null, starred: false } as unknown as Email;
    expect(inView(base, 'sent')).toBe(true);
    expect(inView(base, 'scheduled')).toBe(false);
    expect(inView({ ...base, archived_at: new Date() }, 'sent')).toBe(false);
    expect(inView({ ...base, starred: true }, 'starred')).toBe(true);
  });
});

describe('SMTP failure classification', () => {
  it('retries only when nothing can have been delivered', () => {
    expect(classifySmtpError(Object.assign(new Error('x'), { code: 'ECONNECTION' }), false).kind).toBe('retryable');
    expect(classifySmtpError(Object.assign(new Error('x'), { responseCode: 421, response: '421 busy' }), true).kind).toBe('retryable');
    expect(classifySmtpError(Object.assign(new Error('x'), { responseCode: 550, response: '550 no such user' }), true).kind).toBe('permanent');
    // The connection broke after DATA: the server may have the message. Never retried.
    expect(classifySmtpError(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }), true).kind).toBe('unknown');
  });
});
