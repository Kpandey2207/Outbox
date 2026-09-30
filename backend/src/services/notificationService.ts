import { logger } from '../config/logger.js';
import { postToInstall } from '../integrations/slack.js';
import { slackRepository } from '../repositories/slackRepository.js';
import { safeError } from '../utils/errors.js';

export interface RateLimitAlert {
  userId: string;
  senderEmail: string;
  limit: number;
  reason: 'sender_hourly_limit' | 'global_hourly_limit';
  resumesAt: Date;
  /** True when emails were actually pushed to a later hour; false when the last slot was just used. */
  deferred?: boolean;
}

/**
 * Slack is a side channel. Every failure here is logged and swallowed so a Slack outage,
 * a revoked token or a deleted channel can never fail or delay an email job.
 */
export const notificationService = {
  async rateLimitReached(alert: RateLimitAlert): Promise<boolean> {
    try {
      const install = await slackRepository.findByUser(alert.userId);
      if (!install) return false;
      const scope = alert.reason === 'sender_hourly_limit' ? `Sender ${alert.senderEmail}` : 'The global send quota';
      const text =
        `:warning: ${scope} reached its hourly limit of ${alert.limit} emails. ` +
        (alert.deferred === false
          ? `Any further emails this hour will be rescheduled to ${alert.resumesAt.toUTCString()} or later.`
          : `Remaining emails were rescheduled, starting ${alert.resumesAt.toUTCString()}.`);
      await postToInstall(install, text, [
        { type: 'section', text: { type: 'mrkdwn', text } },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: 'Outbox scheduler · nothing was dropped, sending resumes automatically' }],
        },
      ]);
      return true;
    } catch (err) {
      logger.warn({ err: safeError(err), userId: alert.userId }, 'slack notification failed');
      return false;
    }
  },
};
