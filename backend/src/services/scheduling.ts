export const HOUR_MS = 3_600_000;

export interface SchedulePlanInput {
  recipients: string[];
  startAt: Date;
  delayBetweenMs: number;
  hourlyLimit: number;
}

/**
 * Assigns each recipient a send time that already honours the campaign's delay and hourly
 * limit, so the dashboard shows realistic times up front:
 *
 *   t[i] = max(t[i-1] + delay, startAt + floor(i / hourlyLimit) hours)
 *
 * This is only the plan. The Redis limiter in the worker is what enforces limits, because it
 * also sees other campaigns that share the sender.
 */
export function planSchedule(input: SchedulePlanInput): { recipient: string; scheduledAt: Date }[] {
  const start = input.startAt.getTime();
  const out: { recipient: string; scheduledAt: Date }[] = [];
  let prev = -Infinity;
  input.recipients.forEach((recipient, i) => {
    const hourFloor = start + Math.floor(i / input.hourlyLimit) * HOUR_MS;
    const t = Math.max(prev + input.delayBetweenMs, hourFloor);
    out.push({ recipient, scheduledAt: new Date(t) });
    prev = t;
  });
  return out;
}

const EMAIL_RE = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]{2,}$/;

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}

/** Trims, lower-cases and de-duplicates, keeping first-seen order. */
export function normalizeRecipients(values: string[]): { valid: string[]; invalid: string[]; duplicates: number } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  let duplicates = 0;
  for (const raw of values) {
    const v = raw.trim().toLowerCase();
    if (!v) continue;
    if (!isValidEmail(v)) {
      invalid.push(raw.trim());
      continue;
    }
    if (seen.has(v)) {
      duplicates++;
      continue;
    }
    seen.add(v);
    valid.push(v);
  }
  return { valid, invalid, duplicates };
}
