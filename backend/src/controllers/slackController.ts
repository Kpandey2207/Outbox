import type { Request, Response } from 'express';
import { logger } from '../config/logger.js';
import { exchangeSlackCode, isSlackConfigured, postToInstall, revokeSlackToken, SlackError, slackAuthorizeUrl } from '../integrations/slack.js';
import { currentUser } from '../middleware/auth.js';
import { slackRepository } from '../repositories/slackRepository.js';
import { authService } from '../services/authService.js';
import { badGateway, badRequest, safeError, serviceUnavailable } from '../utils/errors.js';
import { baseCookie, NONCE_COOKIE, redirectToApp, setNonceCookie } from './authController.js';

export const slackController = {
  install(req: Request, res: Response) {
    if (!isSlackConfigured()) throw serviceUnavailable('Slack is not configured on this server');
    const { state, nonce } = authService.issueState('slack', currentUser(req).id);
    setNonceCookie(res, nonce);
    res.redirect(slackAuthorizeUrl(state));
  },

  async callback(req: Request, res: Response) {
    const user = req.user;
    const { code, state, error } = req.query as Record<string, string | undefined>;
    const claims = state ? authService.verifyState(state, 'slack', req.cookies?.[NONCE_COOKIE]) : null;
    res.clearCookie(NONCE_COOKIE, baseCookie());
    if (!user) return redirectToApp(res, '/login', { error: 'slack_signed_out' });
    if (error) return redirectToApp(res, '/scheduled', { slack: 'denied' });
    if (!code || !claims || claims.uid !== user.id) return redirectToApp(res, '/scheduled', { slack: 'invalid_state' });
    try {
      const result = await exchangeSlackCode(code);
      await slackRepository.upsert({
        user_id: user.id,
        team_id: result.teamId,
        team_name: result.teamName,
        bot_token: result.botToken,
        channel_id: result.channelId,
        channel_name: result.channelName,
        webhook_url: result.webhookUrl,
      });
      redirectToApp(res, '/scheduled', { slack: 'connected' });
    } catch (err) {
      logger.warn({ err: safeError(err), userId: user.id }, 'slack install failed');
      redirectToApp(res, '/scheduled', { slack: 'failed' });
    }
  },

  /** Forgets the install, then revokes the token at Slack (best effort: the row is gone either way). */
  async disconnect(req: Request, res: Response) {
    const user = currentUser(req);
    const token = await slackRepository.remove(user.id);
    if (token) {
      await revokeSlackToken(token).catch((err) =>
        logger.warn({ err: safeError(err), userId: user.id }, 'slack token revoke failed'),
      );
    }
    res.status(204).end();
  },

  async test(req: Request, res: Response) {
    const install = await slackRepository.findByUser(currentUser(req).id);
    if (!install) throw badRequest('Slack is not connected');
    try {
      await postToInstall(install, ':wave: Outbox is connected. Rate limit alerts will show up here.');
    } catch (err) {
      const code = err instanceof SlackError ? err.slackCode : 'request_failed';
      logger.warn({ err: safeError(err) }, 'slack test message failed');
      throw badGateway(
        ['token_revoked', 'invalid_auth', 'account_inactive', 'invalid_token', 'no_service', 'channel_is_archived'].includes(code)
          ? 'Slack no longer accepts this connection. Disconnect and connect Slack again.'
          : `Slack did not accept the message (${code}).`,
      );
    }
    res.json({ ok: true });
  },
};
