import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { closeSharedRedis } from '../src/queue/connection.js';
import { closeEmailQueue, emailQueue } from '../src/queue/emailQueue.js';
import { resetState } from './helpers.js';

const app = createApp();

async function login() {
  const agent = request.agent(app);
  await agent.post('/auth/dev-login').expect(200);
  const me = await agent.get('/api/me').expect(200);
  return { agent, senderId: me.body.senders[0].id as string };
}

const campaign = (senderId: string, extra: Record<string, unknown> = {}) => ({
  senderId,
  subject: 'Quarterly update',
  body: '<p>Hello there</p>',
  recipients: ['ann@example.com', 'bob@example.com', 'ANN@example.com'],
  startAt: new Date(Date.now() + 3_600_000).toISOString(),
  delayBetweenSeconds: 2,
  hourlyLimit: 50,
  ...extra,
});

describe('HTTP API', () => {
  beforeEach(async () => {
    await resetState();
  });

  afterAll(async () => {
    await closeEmailQueue();
    await closeSharedRedis();
    await pool.end();
  });

  it('rejects unauthenticated requests', async () => {
    await request(app).get('/api/emails').expect(401);
    await request(app).get('/admin/queues').expect(401);
  });

  it('signs up and back in with email and password', async () => {
    const agent = request.agent(app);
    const body = { email: 'New.Person@example.com', password: 'correct horse battery' };
    const first = await agent.post('/auth/email').send(body).expect(201);
    expect(first.body.created).toBe(true);
    const me = await agent.get('/api/me').expect(200);
    expect(me.body.user.email).toBe('new.person@example.com');
    expect(me.body.senders).toHaveLength(1);

    await request(app).post('/auth/email').send(body).expect(200);
    await request(app).post('/auth/email').send({ ...body, password: 'wrong password!' }).expect(401);
    await request(app).post('/auth/email').send({ email: 'x@example.com', password: 'short' }).expect(400);
  });

  it('signs in and provisions a default sender', async () => {
    const { agent } = await login();
    const me = await agent.get('/api/me').expect(200);
    expect(me.body.user.email).toBe('demo@outbox.local');
    expect(me.body.senders).toHaveLength(1);
  });

  it('schedules a campaign, de-duplicates recipients and lists them', async () => {
    const { agent, senderId } = await login();
    const res = await agent.post('/api/campaigns').send(campaign(senderId)).expect(201);
    expect(res.body.scheduled).toBe(2);
    expect(await emailQueue().getDelayedCount()).toBe(2);

    const list = await agent.get('/api/emails?status=scheduled').expect(200);
    expect(list.body.total).toBe(2);
    expect(list.body.items.map((e: { to: string }) => e.to)).toEqual(['ann@example.com', 'bob@example.com']);
    expect(list.body.items[0]).toMatchObject({ from: 'demo@outbox.local', fromName: 'Demo User' });
    expect(list.body.items[0].via).toMatch(/@ethereal\.email$/);
    const gap = new Date(list.body.items[1].scheduledAt).getTime() - new Date(list.body.items[0].scheduledAt).getTime();
    expect(gap).toBe(2000);

    const counts = await agent.get('/api/emails/counts').expect(200);
    expect(counts.body).toEqual({ scheduled: 2, sent: 0, starred: 0, archived: 0 });

    const search = await agent.get('/api/emails?status=scheduled&q=bob').expect(200);
    expect(search.body.items.map((e: { to: string }) => e.to)).toEqual(['bob@example.com']);
  });

  it('replays a retried request with the same Idempotency-Key instead of scheduling twice', async () => {
    const { agent, senderId } = await login();
    const body = campaign(senderId);
    const first = await agent.post('/api/campaigns').set('Idempotency-Key', 'abc-123').send(body).expect(201);
    const [second, third] = await Promise.all([
      agent.post('/api/campaigns').set('Idempotency-Key', 'abc-123').send(body),
      agent.post('/api/campaigns').set('Idempotency-Key', 'abc-123').send(body),
    ]);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(second.body.campaignId).toBe(first.body.campaignId);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM emails');
    expect(rows[0].n).toBe(2);
  });

  it('validates input', async () => {
    const { agent, senderId } = await login();
    const res = await agent.post('/api/campaigns').send(campaign(senderId, { hourlyLimit: 0, recipients: [] })).expect(400);
    expect(res.body.error.code).toBe('bad_request');
    await agent.post('/api/campaigns').send(campaign(senderId, { recipients: ['nope'] })).expect(400);
  });

  it('parses an uploaded CSV of leads', async () => {
    const { agent } = await login();
    const res = await agent
      .post('/api/leads/parse')
      .attach('file', Buffer.from('email,name\nann@example.com,Ann\nbad,Bad\n'), 'leads.csv')
      .expect(200);
    expect(res.body.emails).toEqual(['ann@example.com']);
    expect(res.body.invalidCount).toBe(1);
  });

  it('uploads attachments, links them to a campaign and serves them back', async () => {
    const { agent, senderId } = await login();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const up = await agent
      .post('/api/attachments')
      .attach('files', png, 'photo.png')
      .attach('files', Buffer.from('%PDF-1.4 hello'), 'brief.pdf')
      .expect(201);
    expect(up.body.items.map((a: { filename: string; contentType: string }) => [a.filename, a.contentType])).toEqual([
      ['photo.png', 'image/png'],
      ['brief.pdf', 'application/pdf'],
    ]);
    const ids = up.body.items.map((a: { id: string }) => a.id);

    const img = await agent.get(`/api/attachments/${ids[0]}`).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['content-disposition']).toMatch(/^inline/);
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    const pdf = await agent.get(`/api/attachments/${ids[1]}`).expect(200);
    expect(pdf.headers['content-disposition']).toMatch(/^attachment/);

    await agent.post('/api/campaigns').send(campaign(senderId, { attachmentIds: ids })).expect(201);
    const list = await agent.get('/api/emails').expect(200);
    const detail = await agent.get(`/api/emails/${list.body.items[0].id}`).expect(200);
    expect(detail.body.attachments.map((a: { filename: string }) => a.filename)).toEqual(['photo.png', 'brief.pdf']);

    // Once scheduled, a file can't be reused by another campaign or deleted from under it.
    await agent.post('/api/campaigns').send(campaign(senderId, { attachmentIds: ids })).expect(400);
    await agent.delete(`/api/attachments/${ids[0]}`).expect(404);

    // Another user can't read them.
    const other = request.agent(app);
    await other.post('/auth/email').send({ email: 'other@example.com', password: 'another password' }).expect(201);
    await other.get(`/api/attachments/${ids[0]}`).expect(404);
  });

  it('rejects attachment types that could run script, and empty files', async () => {
    const { agent } = await login();
    await agent.post('/api/attachments').attach('files', Buffer.from('<svg onload=alert(1)>'), 'x.svg').expect(400);
    await agent.post('/api/attachments').attach('files', Buffer.from('<script>'), 'x.html').expect(400);
    await agent.post('/api/attachments').attach('files', Buffer.alloc(0), 'empty.txt').expect(400);
    const ok = await agent.post('/api/attachments').attach('files', Buffer.from('hi'), 'notes.txt').expect(201);
    await agent.delete(`/api/attachments/${ok.body.items[0].id}`).expect(204);
  });

  it('rolls back the campaign when an attachment id is not the user\'s', async () => {
    const { agent, senderId } = await login();
    await agent
      .post('/api/campaigns')
      .send(campaign(senderId, { attachmentIds: ['00000000-0000-4000-8000-000000000000'] }))
      .expect(400);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM campaigns');
    expect(rows[0].n).toBe(0);
  });

  it('deleting a scheduled email cancels it and removes its job', async () => {
    const { agent, senderId } = await login();
    await agent.post('/api/campaigns').send(campaign(senderId)).expect(201);
    const list = await agent.get('/api/emails').expect(200);
    const id = list.body.items[0].id;
    await agent.delete(`/api/emails/${id}`).expect(204);
    await agent.delete(`/api/emails/${id}`).expect(404);
    await agent.get(`/api/emails/${id}`).expect(404);
    expect(await emailQueue().getJob(id)).toBeUndefined();
    const { rows } = await pool.query('SELECT status FROM emails WHERE id = $1', [id]);
    expect(rows[0].status).toBe('cancelled');
    expect((await agent.get('/api/emails/counts').expect(200)).body.scheduled).toBe(1);
  });

  it('stars, archives and deletes sent emails', async () => {
    const { agent, senderId } = await login();
    await agent.post('/api/campaigns').send(campaign(senderId)).expect(201);
    // Pretend both went out.
    await pool.query("UPDATE emails SET status = 'sent', sent_at = now()");
    const sent = await agent.get('/api/emails?status=sent').expect(200);
    const [a, b] = sent.body.items.map((e: { id: string }) => e.id);

    const starred = await agent.patch(`/api/emails/${a}`).send({ starred: true }).expect(200);
    expect(starred.body.starred).toBe(true);
    await agent.patch(`/api/emails/${b}`).send({ archived: true }).expect(200);
    await agent.patch(`/api/emails/${b}`).send({}).expect(400);

    const ids = async (status: string) =>
      (await agent.get(`/api/emails?status=${status}`).expect(200)).body.items.map((e: { id: string }) => e.id);
    expect(await ids('sent')).toEqual([a]);
    expect(await ids('starred')).toEqual([a]);
    expect(await ids('archived')).toEqual([b]);
    expect((await agent.get('/api/emails/counts').expect(200)).body).toEqual({ scheduled: 0, sent: 1, starred: 1, archived: 1 });

    // The Filter menu narrows a mailbox to one status.
    await pool.query("UPDATE emails SET status = 'failed' WHERE id = $1", [a]);
    expect(await ids('sent&only=failed')).toEqual([a]);
    expect(await ids('sent&only=sent')).toEqual([]);
    expect(await ids('sent&only=scheduled')).toEqual([]);
    await pool.query("UPDATE emails SET status = 'sent' WHERE id = $1", [a]);

    // Unarchive brings it back to Sent; delete hides it everywhere.
    await agent.patch(`/api/emails/${b}`).send({ archived: false }).expect(200);
    expect(await ids('sent')).toHaveLength(2);
    await agent.delete(`/api/emails/${a}`).expect(204);
    expect(await ids('sent')).toEqual([b]);
    expect(await ids('starred')).toEqual([]);
    await agent.patch(`/api/emails/${a}`).send({ starred: false }).expect(404);
  });

  it('will not delete an email while it is being sent', async () => {
    const { agent, senderId } = await login();
    await agent.post('/api/campaigns').send(campaign(senderId)).expect(201);
    const { rows } = await pool.query("UPDATE emails SET status = 'sending', sending_started_at = now() RETURNING id");
    await agent.delete(`/api/emails/${rows[0].id}`).expect(409);
  });

  it('serves Bull Board to signed-in users', async () => {
    const { agent } = await login();
    const res = await agent.get('/admin/queues').expect(200);
    expect(res.text).toContain('<html');
  });
});
