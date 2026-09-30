import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { sharedRedis } from '../queue/connection.js';
import { currentUser } from './auth.js';
import { forbidden, safeError, tooManyRequests } from '../utils/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence in depth on top of SameSite=Lax cookies. A browser always labels a
 * state-changing request with where it came from; anything from another site is refused.
 * Requests with neither header (curl, server-to-server, tests) carry no ambient browser
 * cookies from a victim, so they pass and still need a valid session.
 */
export function sameOriginWrites() {
  const allowed = new Set([new URL(env.FRONTEND_URL).origin, new URL(env.API_URL).origin]);
  return (req: Request, _res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (req.get('sec-fetch-site') === 'cross-site') return next(forbidden('Cross-site request refused'));
    const origin = req.get('origin');
    if (origin !== undefined) {
      return allowed.has(origin) ? next() : next(forbidden('Cross-site request refused'));
    }
    const referer = req.get('referer');
    if (referer) {
      let refOrigin = '';
      try {
        refOrigin = new URL(referer).origin;
      } catch {
        // unparsable: treated as foreign
      }
      if (!allowed.has(refOrigin)) return next(forbidden('Cross-site request refused'));
    }
    next();
  };
}

export interface RateLimitRule {
  /** Namespaces the counter, e.g. "login". */
  name: string;
  windowSeconds: number;
  max: number;
  /** Counts per signed-in user (after requireAuth) or per client IP. */
  by: 'user' | 'ip';
}

/**
 * Fixed-window request limit in Redis, shared by every API instance. Fails open: if Redis is
 * unreachable the request goes through, because refusing all traffic would be worse (the
 * email pipeline itself still depends on Redis and reports its own errors).
 */
export function rateLimit(rule: RateLimitRule) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!env.RATE_LIMIT_ENABLED) return next();
    const who = rule.by === 'user' ? currentUser(req).id : (req.ip ?? 'unknown');
    const window = Math.floor(Date.now() / 1000 / rule.windowSeconds);
    const key = `outbox:ratelimit:${rule.name}:${who}:${window}`;
    let count: number;
    try {
      const out = await sharedRedis().multi().incr(key).expire(key, rule.windowSeconds + 5, 'NX').exec();
      count = Number(out?.[0]?.[1] ?? 0);
    } catch (err) {
      logger.warn({ err: safeError(err), rule: rule.name }, 'rate limit check failed; allowing request');
      return next();
    }
    res.setHeader('RateLimit-Limit', String(rule.max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, rule.max - count)));
    if (count > rule.max) {
      const retryAfter = (window + 1) * rule.windowSeconds - Math.floor(Date.now() / 1000);
      res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
      return next(tooManyRequests());
    }
    next();
  };
}
