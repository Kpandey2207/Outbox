import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeSharedRedis, sharedRedis } from '../src/queue/connection.js';
import { RateLimiter } from '../src/queue/rateLimiter.js';

const limiter = () => new RateLimiter(sharedRedis(), `test:rl:${Math.random().toString(36).slice(2)}`);

describe('RateLimiter', () => {
  beforeEach(async () => {
    await sharedRedis().flushdb();
  });
  afterAll(async () => {
    await closeSharedRedis();
  });

  it('never lets more than the hourly limit through under heavy concurrency', async () => {
    const rl = limiter();
    const decisions = await Promise.all(
      Array.from({ length: 200 }, () =>
        rl.acquire({ senderId: 's1', senderHourlyLimit: 25, globalHourlyLimit: 1000, minDelayMs: 0 }),
      ),
    );
    expect(decisions.filter((d) => d.allowed)).toHaveLength(25);
    const rejected = decisions.filter((d) => !d.allowed);
    expect(rejected.every((d) => d.reason === 'sender_hourly_limit')).toBe(true);
    // Each rejected send gets its own slot in a later hour, not one shared instant.
    const slots = rejected.map((d) => d.retryAt);
    expect(Math.min(...slots)).toBeGreaterThan(Date.now());
    const firstHour = slots.filter((s) => s === Math.min(...slots));
    expect(firstHour.length).toBeLessThanOrEqual(25);
  });

  it('keeps separate budgets per sender but shares the global one', async () => {
    const rl = limiter();
    const a = await Promise.all(Array.from({ length: 5 }, () => rl.acquire({ senderId: 'a', senderHourlyLimit: 5, globalHourlyLimit: 7, minDelayMs: 0 })));
    const b = await Promise.all(Array.from({ length: 5 }, () => rl.acquire({ senderId: 'b', senderHourlyLimit: 5, globalHourlyLimit: 7, minDelayMs: 0 })));
    expect(a.filter((d) => d.allowed)).toHaveLength(5);
    expect(b.filter((d) => d.allowed)).toHaveLength(2);
    expect(b.filter((d) => !d.allowed).every((d) => d.reason === 'global_hourly_limit')).toBe(true);
  });

  it('enforces the minimum delay between sends of one sender', async () => {
    const rl = limiter();
    const first = await rl.acquire({ senderId: 's', senderHourlyLimit: 100, globalHourlyLimit: 100, minDelayMs: 500 });
    const second = await rl.acquire({ senderId: 's', senderHourlyLimit: 100, globalHourlyLimit: 100, minDelayMs: 500 });
    expect(first.allowed).toBe(true);
    expect(second).toMatchObject({ allowed: false, reason: 'throttle' });
    expect(second.retryAt - first.retryAt).toBe(500);
    // Coming back early with the reservation still waits for it.
    const early = await rl.acquire({ senderId: 's', senderHourlyLimit: 100, globalHourlyLimit: 100, minDelayMs: 500, reservedSlot: second.retryAt });
    expect(early).toMatchObject({ allowed: false, retryAt: second.retryAt });
    await new Promise((r) => setTimeout(r, second.retryAt - Date.now() + 20));
    const onTime = await rl.acquire({ senderId: 's', senderHourlyLimit: 100, globalHourlyLimit: 100, minDelayMs: 500, reservedSlot: second.retryAt });
    expect(onTime.allowed).toBe(true);
  });

  it('queues throttled senders one delay apart in arrival order, instead of a stampede', async () => {
    const rl = limiter();
    const input = { senderId: 'q', senderHourlyLimit: 100, globalHourlyLimit: 100, minDelayMs: 1_000 };
    const first = await rl.acquire(input);
    const waiting = [];
    for (let i = 0; i < 5; i++) waiting.push(await rl.acquire(input));
    expect(first.allowed).toBe(true);
    expect(waiting.every((d) => d.reason === 'throttle')).toBe(true);
    // Five distinct slots, each exactly one delay after the previous one.
    expect(waiting.map((d) => d.retryAt - first.retryAt)).toEqual([1_000, 2_000, 3_000, 4_000, 5_000]);
  });

  it('does not let one campaign\'s overflow push another campaign with a lower limit days out', async () => {
    const rl = limiter();
    for (let i = 0; i < 210; i++) await rl.acquire({ senderId: 'o', senderHourlyLimit: 10, globalHourlyLimit: 10_000, minDelayMs: 0 });
    const small = await rl.acquire({ senderId: 'o', senderHourlyLimit: 5, globalHourlyLimit: 10_000, minDelayMs: 0 });
    expect(small.reason).toBe('sender_hourly_limit');
    expect(small.retryAt - Date.now()).toBeLessThan(2 * 3_600_000);
  });

  it('never packs more overflow into an hour than the delay allows', async () => {
    const rl = limiter();
    const input = { senderId: 'p', senderHourlyLimit: 200, globalHourlyLimit: 10_000, minDelayMs: 0 };
    for (let i = 0; i < 200; i++) await rl.acquire(input);
    // 30 s apart fits 120 sends an hour; the 121st overflow goes to the hour after, not to 59:59.
    const slots = [];
    for (let i = 0; i < 130; i++) slots.push((await rl.acquire({ ...input, minDelayMs: 30_000 })).retryAt);
    expect(new Set(slots).size).toBe(130);
    expect(slots[120]! - slots[0]!).toBe(3_600_000);
  });

  it('reports the first limit hit of an hour exactly once', async () => {
    const rl = limiter();
    const results = await Promise.all(Array.from({ length: 10 }, () => rl.firstLimitHitThisHour('s', 42, 'sender_hourly_limit')));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
