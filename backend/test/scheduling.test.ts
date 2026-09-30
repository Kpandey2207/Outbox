import { describe, expect, it } from 'vitest';
import { HOUR_MS, normalizeRecipients, planSchedule } from '../src/services/scheduling.js';
import { parseLeadsCsv } from '../src/services/leadService.js';

describe('planSchedule', () => {
  const start = new Date('2026-01-01T10:00:00Z');

  it('spaces sends by the delay', () => {
    const plan = planSchedule({ recipients: ['a@x.io', 'b@x.io', 'c@x.io'], startAt: start, delayBetweenMs: 2000, hourlyLimit: 100 });
    expect(plan.map((p) => p.scheduledAt.getTime() - start.getTime())).toEqual([0, 2000, 4000]);
  });

  it('pushes sends past the hourly limit into the next hour', () => {
    const recipients = Array.from({ length: 5 }, (_, i) => `u${i}@x.io`);
    const plan = planSchedule({ recipients, startAt: start, delayBetweenMs: 1000, hourlyLimit: 2 });
    expect(plan.map((p) => p.scheduledAt.getTime() - start.getTime())).toEqual([
      0, 1000, HOUR_MS, HOUR_MS + 1000, 2 * HOUR_MS,
    ]);
  });
});

describe('normalizeRecipients', () => {
  it('lower-cases, de-duplicates and rejects junk', () => {
    const r = normalizeRecipients([' A@x.io', 'a@x.io', 'not-an-email', '', 'b@y.co']);
    expect(r).toEqual({ valid: ['a@x.io', 'b@y.co'], invalid: ['not-an-email'], duplicates: 1 });
  });
});

describe('parseLeadsCsv', () => {
  it('uses the email column when there is a header', () => {
    const r = parseLeadsCsv(Buffer.from('name,email\nAnn,ann@x.io\nBob,BOB@x.io\nBad,nope\n'));
    expect(r.emails).toEqual(['ann@x.io', 'bob@x.io']);
    expect(r.invalidCount).toBe(1);
  });

  it('accepts a bare list with no header', () => {
    const r = parseLeadsCsv(Buffer.from('ann@x.io\nbob@x.io\nann@x.io\n'));
    expect(r.emails).toEqual(['ann@x.io', 'bob@x.io']);
    expect(r.duplicates).toBe(1);
  });
});
