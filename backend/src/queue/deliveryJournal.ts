import type { Redis } from 'ioredis';

export interface DeliveryRecord {
  messageId: string;
  previewUrl: string | null;
}

/**
 * Written the instant SMTP accepts a message, before Postgres is updated, for the window where
 * SMTP said yes but the `sent` write failed or the process died: recovery then records the
 * email as sent instead of "outcome unknown". It only ever upgrades an unknown outcome to
 * `sent`, never decides that a message may be sent, so losing Redis data can cost an accurate
 * status but never cause a duplicate.
 */
export class DeliveryJournal {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'outbox:delivered',
    private readonly ttlSeconds = 14 * 24 * 3600,
  ) {}

  async record(emailId: string, rec: DeliveryRecord): Promise<void> {
    await this.redis.set(`${this.prefix}:${emailId}`, JSON.stringify(rec), 'EX', this.ttlSeconds);
  }

  async find(emailId: string): Promise<DeliveryRecord | null> {
    const raw = await this.redis.get(`${this.prefix}:${emailId}`);
    return raw ? (JSON.parse(raw) as DeliveryRecord) : null;
  }
}
