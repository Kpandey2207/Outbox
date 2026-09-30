import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { User } from '../models/types.js';
import { sessionRepository } from '../repositories/sessionRepository.js';
import { userRepository } from '../repositories/userRepository.js';
import type { UpsertUserInput } from '../repositories/userRepository.js';
import { senderService } from './senderService.js';
import { logger } from '../config/logger.js';
import { revokeSlackToken } from '../integrations/slack.js';
import { sharedRedis } from '../queue/connection.js';
import { emailQueue } from '../queue/emailQueue.js';
import { attachmentRepository } from '../repositories/attachmentRepository.js';
import { emailRepository } from '../repositories/emailRepository.js';
import { slackRepository } from '../repositories/slackRepository.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { AppError, conflict, safeError } from '../utils/errors.js';

/**
 * Password guessing is capped per email *and client*, so a stranger cannot lock someone out
 * of their account by failing on purpose. A much higher per-email cap still stops a
 * distributed guess against one account.
 */
const MAX_ATTEMPTS_PER_CLIENT = 10;
const MAX_ATTEMPTS_PER_EMAIL = 100;
const ATTEMPT_WINDOW_S = 15 * 60;

interface StateClaims {
  typ: 'oauth_state';
  purpose: 'google' | 'slack';
  nonce: string;
  uid?: string;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest();

export const authService = {
  /**
   * Sessions are opaque random tokens looked up in Postgres, not self-contained JWTs, so
   * logging out ends the session for real and a compromised account can be signed out.
   */
  async createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await sessionRepository.create(userId, hashToken(token), env.SESSION_TTL_HOURS);
    return token;
  },

  async userForSession(token: string): Promise<User | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return sessionRepository.findUser(hashToken(token));
  },

  async endSession(token: string): Promise<void> {
    await sessionRepository.revoke(hashToken(token));
  },

  /**
   * OAuth `state` is a short-lived signed token plus a nonce that is also stored in a cookie.
   * The callback requires both to match, which blocks login CSRF and forged Slack installs.
   */
  issueState(purpose: StateClaims['purpose'], uid?: string): { state: string; nonce: string } {
    const nonce = randomBytes(16).toString('hex');
    const claims: StateClaims = { typ: 'oauth_state', purpose, nonce, ...(uid ? { uid } : {}) };
    return { state: jwt.sign(claims, env.JWT_SECRET, { expiresIn: '10m' }), nonce };
  },

  verifyState(state: string, purpose: StateClaims['purpose'], cookieNonce: string | undefined): StateClaims | null {
    try {
      const claims = jwt.verify(state, env.JWT_SECRET, { algorithms: ['HS256'] }) as StateClaims;
      if (claims.typ !== 'oauth_state' || claims.purpose !== purpose) return null;
      if (!cookieNonce || cookieNonce !== claims.nonce) return null;
      return claims;
    } catch {
      return null;
    }
  },

  async signIn(profile: UpsertUserInput): Promise<User> {
    const existing = profile.googleId ? await userRepository.findByEmail(profile.email) : null;
    // An account is bound to the first Google identity that claimed it. A different Google
    // account presenting the same address (a recycled Workspace mailbox, say) is refused.
    if (existing?.google_id && profile.googleId && existing.google_id !== profile.googleId) {
      throw new AppError(409, 'google_account_mismatch', 'This email belongs to a different Google account');
    }
    const user = await userRepository.upsert(profile);
    // Pre-hijack protection: email + password sign up does not verify the address, so anyone
    // could have claimed it first. Google just proved ownership, so drop that password, end
    // its sessions and undo what it set up.
    if (existing?.password_hash && !existing.google_id) {
      await userRepository.clearPassword(user.id);
      await sessionRepository.revokeAllForUser(user.id);
      await authService.discardSquatterSetup(user.id);
    }
    await senderService.ensureDefault(user);
    return user;
  },

  /** Unsent mail, pending uploads and the Slack install made before the owner proved the address. */
  async discardSquatterSetup(userId: string): Promise<void> {
    const cancelled = await emailRepository.cancelAllScheduled(userId);
    await Promise.all(cancelled.map((id) => emailQueue().remove(id).catch(() => undefined)));
    await attachmentRepository.deleteAllUnlinked(userId);
    const token = await slackRepository.remove(userId);
    if (token) await revokeSlackToken(token).catch((err) => logger.warn({ err: safeError(err) }, 'slack token revoke failed'));
    if (cancelled.length > 0) logger.info({ userId, cancelled: cancelled.length }, 'cancelled mail scheduled before the address was verified');
  },

  /** Signs in an existing email account, or creates one if the address is new. */
  async emailSignIn(email: string, password: string, clientIp = 'unknown'): Promise<{ user: User; created: boolean }> {
    const address = email.toLowerCase();
    const clientKey = `outbox:login-attempts:${address}:${clientIp}`;
    const emailKey = `outbox:login-attempts:${address}`;
    // One round trip, so a crash can never leave a counter without its expiry (a permanent lockout).
    const res = await sharedRedis()
      .multi()
      .incr(clientKey)
      .expire(clientKey, ATTEMPT_WINDOW_S, 'NX')
      .incr(emailKey)
      .expire(emailKey, ATTEMPT_WINDOW_S, 'NX')
      .exec();
    const perClient = Number(res?.[0]?.[1] ?? Infinity);
    const perEmail = Number(res?.[2]?.[1] ?? Infinity);
    if (perClient > MAX_ATTEMPTS_PER_CLIENT || perEmail > MAX_ATTEMPTS_PER_EMAIL) {
      throw new AppError(429, 'too_many_attempts', 'Too many attempts. Try again in 15 minutes.');
    }

    const existing = await userRepository.findByEmail(email);
    if (existing) {
      if (!existing.password_hash) throw conflict('This account signs in with Google. Use "Login with Google".');
      if (!(await verifyPassword(password, existing.password_hash))) {
        throw new AppError(401, 'invalid_credentials', 'Incorrect email or password');
      }
      await sharedRedis().del(clientKey);
      return { user: existing, created: false };
    }

    const created = await userRepository.createWithPassword(email, await hashPassword(password));
    if (!created) throw conflict('An account with this email was just created. Try signing in again.');
    await senderService.ensureDefault(created);
    await sharedRedis().del(clientKey);
    return { user: created, created: true };
  },
};
