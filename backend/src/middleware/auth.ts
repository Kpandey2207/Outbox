import type { NextFunction, Request, Response } from 'express';
import { authService } from '../services/authService.js';
import type { User } from '../models/types.js';
import { env, isLocalOrigin } from '../config/env.js';
import { forbidden, unauthorized } from '../utils/errors.js';

export const SESSION_COOKIE = 'outbox_session';

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
  }
}

async function sessionUser(req: Request): Promise<User | null> {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  return token ? authService.userForSession(token) : null;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const user = await sessionUser(req);
  if (!user) return next(unauthorized());
  req.user = user;
  next();
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const user = await sessionUser(req);
  if (user) req.user = user;
  next();
}

/** For handlers mounted behind requireAuth. */
export function currentUser(req: Request): User {
  if (!req.user) throw unauthorized();
  return req.user;
}

/**
 * Bull Board can retry or delete every user's jobs, so it is limited to QUEUE_ADMIN_EMAILS
 * (`*` for any signed-in user). Without that list it is open only on a localhost development
 * setup, so a dev server exposed through a tunnel does not hand it to strangers.
 */
export function canSeeQueues(user: Pick<User, 'email'>): boolean {
  if (env.QUEUE_ADMIN_EMAILS) {
    return env.QUEUE_ADMIN_EMAILS.includes('*') || env.QUEUE_ADMIN_EMAILS.includes(user.email.toLowerCase());
  }
  return env.NODE_ENV !== 'production' && isLocalOrigin(env.FRONTEND_URL);
}

export function requireQueueAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!canSeeQueues(currentUser(req))) return next(forbidden('The queue dashboard is limited to operators'));
  next();
}
