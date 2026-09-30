import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Point at a port where nothing listens, before any app module reads the env.
process.env.ELASTICSEARCH_URL = 'http://127.0.0.1:1';

const { resetState, createUserWithSender } = await import('./helpers.js');
const { campaignService } = await import('../src/services/campaignService.js');
const { searchService } = await import('../src/services/searchService.js');
const { pool } = await import('../src/db/pool.js');
const { closeEmailQueue } = await import('../src/queue/emailQueue.js');
const { closeSharedRedis } = await import('../src/queue/connection.js');
const { searchIndex } = await import('../src/integrations/elasticsearch.js');

describe('search when Elasticsearch is down', () => {
  beforeAll(async () => {
    await resetState();
  });
  afterAll(async () => {
    await searchIndex.close();
    await closeEmailQueue();
    await closeSharedRedis();
    await pool.end();
  });

  it('still schedules, and search falls back to Postgres', async () => {
    const { user, sender } = await createUserWithSender();
    const res = await campaignService.create({
      userId: user.id, senderId: sender.id, subject: 'Pricing update', body: 'x',
      recipients: ['ann@example.com', 'bob@example.com'], startAt: new Date(Date.now() + 60_000),
      delayBetweenMs: 0, hourlyLimit: 10, idempotencyKey: null,
    });
    expect(res.scheduled).toBe(2);
    const found = await searchService.search(user.id, 'scheduled', 'bob', 10, 0);
    expect(found.engine).toBe('postgres');
    expect(found.items.map((e) => e.recipient)).toEqual(['bob@example.com']);
  });
});
