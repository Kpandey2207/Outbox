import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env.js';

/**
 * BullMQ needs `maxRetriesPerRequest: null` so blocking commands survive reconnects
 * instead of throwing, which is what lets workers ride out a Redis restart.
 */
export function createRedis(overrides: RedisOptions = {}): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true, ...overrides });
}

let shared: Redis | null = null;

/** Connection for non-blocking commands (rate limiter, Slack de-dupe). */
export function sharedRedis(): Redis {
  shared ??= createRedis();
  return shared;
}

export async function closeSharedRedis(): Promise<void> {
  if (shared) {
    const conn = shared;
    shared = null;
    await conn.quit();
  }
}
