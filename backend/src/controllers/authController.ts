import type { CookieOptions, Request, Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { exchangeGoogleCode, googleAuthorizeUrl, isGoogleConfigured } from '../integrations/google.js';
import { isSlackConfigured } from '../integrations/slack.js';
import { isSearchConfigured } from '../integrations/elasticsearch.js';
import { canSeeQueues, currentUser, SESSION_COOKIE } from '../middleware/auth.js';
import { senderRepository } from '../repositories/senderRepository.js';
import { slackRepository } from '../repositories/slackRepository.js';
import { authService } from '../services/authService.js';
import { AppError, safeError, serviceUnavailable } from '../utils/errors.js';

export const NONCE_COOKIE = 'outbox_oauth_nonce';

const baseCookie = (): CookieOptions => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: env.COOKIE_SECURE,
  path: '/',
});

export function setNonceCookie(res: Response, nonce: string) {
  res.cookie(NONCE_COOKIE, nonce, { ...baseCookie(), maxAge: 10 * 60 * 1000 });
}

async function setSession(req: Request, res: Response, userId: string) {
  // A fresh token on every sign in (no session fixation); the old one, if any, is ended.
  const previous = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (previous) await authService.endSession(previous).catch(() => undefined);
  res.cookie(SESSION_COOKIE, await authService.createSession(userId), {
    ...baseCookie(),
    maxAge: env.SESSION_TTL_HOURS * 3600 * 1000,
  });
}

const redirectToApp = (res: Response, path = '/', params: Record<string, string> = {}) => {
  const url = new URL(path, env.FRONTEND_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  res.redirect(url.toString());
};

export const authController = {
  config(_req: Request, res: Response) {
    res.json({ googleEnabled: isGoogleConfigured(), devLoginEnabled: env.DEV_LOGIN_ENABLED });
  },

  googleStart(_req: Request, res: Response) {
    if (!isGoogleConfigured()) throw serviceUnavailable('Google sign in is not configured');
    const { state, nonce } = authService.issueState('google');
    setNonceCookie(res, nonce);
    res.redirect(googleAuthorizeUrl(state));
  },

  async googleCallback(req: Request, res: Response) {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    const nonce = req.cookies?.[NONCE_COOKIE] as string | undefined;
    res.clearCookie(NONCE_COOKIE, baseCookie());
    if (error) return redirectToApp(res, '/login', { error: 'google_denied' });
    if (!code || !state || !authService.verifyState(state, 'google', nonce)) {
      return redirectToApp(res, '/login', { error: 'invalid_state' });
    }
    try {
      const profile = await exchangeGoogleCode(code);
      const user = await authService.signIn(profile);
      await setSession(req, res, user.id);
      redirectToApp(res, '/scheduled');
    } catch (err) {
      if (err instanceof AppError && err.code === 'google_account_mismatch') {
        return redirectToApp(res, '/login', { error: 'google_mismatch' });
      }
      logger.warn({ err: safeError(err) }, 'google sign in failed');
      redirectToApp(res, '/login', { error: 'google_failed' });
    }
  },

  async emailSignIn(req: Request, res: Response) {
    const { email, password } = res.locals.body as { email: string; password: string };
    const { user, created } = await authService.emailSignIn(email, password, req.ip);
    await setSession(req, res, user.id);
    res.status(created ? 201 : 200).json({ ok: true, created });
  },

  /** Local demo only; refuses to run unless DEV_LOGIN_ENABLED=true (and never in production). */
  async devLogin(req: Request, res: Response) {
    if (!env.DEV_LOGIN_ENABLED) throw new AppError(404, 'not_found', 'Route not found');
    const user = await authService.signIn({
      googleId: null,
      email: 'demo@outbox.local',
      name: 'Demo User',
      avatarUrl: null,
    });
    await setSession(req, res, user.id);
    res.json({ ok: true });
  },

  /** Revokes the session server side, so a copied cookie stops working too. */
  async logout(req: Request, res: Response) {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (token) await authService.endSession(token);
    res.clearCookie(SESSION_COOKIE, baseCookie());
    res.status(204).end();
  },

  async me(req: Request, res: Response) {
    const user = currentUser(req);
    const [senders, slack] = await Promise.all([
      senderRepository.listForUser(user.id),
      slackRepository.findByUser(user.id),
    ]);
    res.json({
      user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatar_url },
      senders,
      slack: slack
        ? { connected: true, teamName: slack.team_name, channelName: slack.channel_name }
        : { connected: false },
      features: { slack: isSlackConfigured(), search: isSearchConfigured(), queueDashboard: canSeeQueues(user) },
      // The compose form validates against these instead of the server silently clamping.
      limits: {
        maxHourlyLimit: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
        minDelaySeconds: env.MIN_DELAY_BETWEEN_SENDS_MS / 1000,
        maxRecipients: env.MAX_RECIPIENTS_PER_CAMPAIGN,
      },
    });
  },
};

export { baseCookie, redirectToApp };
