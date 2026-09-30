import type { Redis } from 'ioredis';

const HOUR_MS = 3_600_000;

/**
 * One atomic Lua script decides whether a sender may send right now. Redis runs scripts one
 * at a time, so every worker on every machine sees one consistent view of the counters and
 * the check and the increment can never interleave.
 *
 * Time comes from Redis (TIME), not the worker, so clock skew between machines cannot open
 * extra room in a window.
 *
 * Order of checks:
 *   1. throttle  - minimum gap between this sender's sends
 *   2. sender    - sends by this sender in the current hour window
 *   3. global    - sends by everyone in the current hour window
 * Only when all three pass are the counters bumped.
 *
 * Throttle slots are handed out as reservations: a caller that must wait is given the next
 * free slot (and the sender's next-free marker moves past it), and when it comes back with
 * that slot it is let through the throttle. Waiting emails therefore queue up one `delay`
 * apart in arrival order instead of all waking at the same instant and fighting again.
 *
 * When an hourly limit is hit the script hands out a slot in a later hour. It counts the
 * overflow per window and per limit value, and never packs more slots into an hour than the
 * delay allows, so N rejected emails get N distinct slots spread `delay` apart.
 *
 * KEYS[1] sender counter prefix, KEYS[2] global counter prefix, KEYS[3] sender throttle key
 * ARGV[1] sender limit, ARGV[2] global limit, ARGV[3] min delay ms, ARGV[4] reserved slot (0 = none)
 * Returns { allowed(0/1), retryAtMs, reason, senderCount, window }
 */
const SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local hour = ${HOUR_MS}
local window = math.floor(now / hour)
local windowEnd = (window + 1) * hour
local senderLimit = tonumber(ARGV[1])
local globalLimit = tonumber(ARGV[2])
local delay = tonumber(ARGV[3])
local reserved = tonumber(ARGV[4])
local senderKey = KEYS[1] .. ':' .. window
local globalKey = KEYS[2] .. ':' .. window
local ttl = math.ceil((windowEnd - now) / 1000) + 3600

local nextSlot = tonumber(redis.call('GET', KEYS[3]) or '0')
local lastKey = KEYS[3] .. ':last'
local lastSend = tonumber(redis.call('GET', lastKey) or '0')
local holdsSlot = reserved > 0 and now < reserved + math.max(delay, 1000)
if holdsSlot and now < math.max(reserved, lastSend + delay) then
  -- Early for its slot, or the previous holder ran late: wait, keeping the reservation.
  return { 0, math.max(reserved, lastSend + delay), 'throttle', 0, window }
end
if (not holdsSlot) and nextSlot > now then
  redis.call('SET', KEYS[3], nextSlot + delay, 'PX', nextSlot + delay - now + 60000)
  return { 0, nextSlot, 'throttle', 0, window }
end

local function overflowSlot(prefix, limit)
  local key = prefix .. ':overflow:' .. limit .. ':' .. window
  local pos = redis.call('INCR', key) - 1
  redis.call('EXPIRE', key, ttl)
  local perHour = limit
  if delay > 0 then perHour = math.max(1, math.min(limit, math.floor(hour / delay))) end
  local extraHours = math.floor(pos / perHour)
  return windowEnd + extraHours * hour + (pos % perHour) * delay
end

local senderCount = tonumber(redis.call('GET', senderKey) or '0')
if senderCount >= senderLimit then
  return { 0, overflowSlot(KEYS[1], senderLimit), 'sender_hourly_limit', senderCount, window }
end

local globalCount = tonumber(redis.call('GET', globalKey) or '0')
if globalCount >= globalLimit then
  return { 0, overflowSlot(KEYS[2], globalLimit), 'global_hourly_limit', senderCount, window }
end

redis.call('INCR', senderKey)
redis.call('EXPIRE', senderKey, ttl)
redis.call('INCR', globalKey)
redis.call('EXPIRE', globalKey, ttl)
if delay > 0 then
  local after = math.max(nextSlot, now + delay)
  redis.call('SET', KEYS[3], after, 'PX', after - now + 60000)
  redis.call('SET', lastKey, now, 'PX', delay + 60000)
end
return { 1, now, 'ok', senderCount + 1, window }
`;

export type LimitReason = 'ok' | 'throttle' | 'sender_hourly_limit' | 'global_hourly_limit';

export interface LimitDecision {
  allowed: boolean;
  /** When the caller should try again (epoch ms, Redis clock). Equals "now" if allowed. */
  retryAt: number;
  reason: LimitReason;
  senderCount: number;
  /** Clock hour the decision was made in, used to de-duplicate notifications. */
  window: number;
}

export interface AcquireInput {
  senderId: string;
  senderHourlyLimit: number;
  globalHourlyLimit: number;
  minDelayMs: number;
  /** A throttle slot this caller was given earlier and is now coming back for. */
  reservedSlot?: number;
}

export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'outbox:rl',
  ) {}

  async acquire(input: AcquireInput): Promise<LimitDecision> {
    const [allowed, retryAt, reason, senderCount, window] = (await this.redis.eval(
      SCRIPT,
      3,
      `${this.prefix}:sender:${input.senderId}`,
      `${this.prefix}:global`,
      `${this.prefix}:throttle:${input.senderId}`,
      input.senderHourlyLimit,
      input.globalHourlyLimit,
      input.minDelayMs,
      input.reservedSlot ?? 0,
    )) as [number, number, string, number, number];
    return {
      allowed: allowed === 1,
      retryAt: Number(retryAt),
      reason: reason as LimitReason,
      senderCount: Number(senderCount),
      window: Number(window),
    };
  }

  /** True exactly once per sender, per reason, per hour window: one Slack alert, not hundreds. */
  async firstLimitHitThisHour(senderId: string, window: number, reason = 'sender_hourly_limit'): Promise<boolean> {
    const res = await this.redis.set(`${this.prefix}:notified:${reason}:${senderId}:${window}`, '1', 'EX', 7200, 'NX');
    return res === 'OK';
  }
}
