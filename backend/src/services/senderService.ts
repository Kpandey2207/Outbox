import { logger } from '../config/logger.js';
import { provisionEtherealAccount } from '../integrations/mailer.js';
import type { PublicSender, User } from '../models/types.js';
import { senderRepository } from '../repositories/senderRepository.js';
import { safeError, serviceUnavailable } from '../utils/errors.js';

export const senderService = {
  list: (userId: string) => senderRepository.listForUser(userId),

  /**
   * Creates a sender backed by an Ethereal inbox, used to log in to SMTP. Recipients see the
   * signed-in user in From and Reply-To; the envelope and the Sender header name this account.
   */
  async create(user: Pick<User, 'id' | 'name'>, displayName?: string | null): Promise<PublicSender> {
    let account: { user: string; pass: string };
    try {
      account = await provisionEtherealAccount();
    } catch (err) {
      logger.error({ err: safeError(err) }, 'could not create ethereal account');
      throw serviceUnavailable('Could not create an Ethereal mailbox right now; try again shortly');
    }
    return senderRepository.create({
      userId: user.id,
      email: account.user,
      displayName: displayName ?? user.name,
      smtpUser: account.user,
      smtpPass: account.pass,
    });
  },

  /** Every user gets one sender on first sign in so they can schedule immediately. */
  async ensureDefault(user: Pick<User, 'id' | 'name'>): Promise<void> {
    const existing = await senderRepository.listForUser(user.id);
    if (existing.length > 0) return;
    try {
      await senderService.create(user);
    } catch (err) {
      // Sign in still succeeds; the dashboard offers "Add sender" to retry.
      logger.warn({ err: safeError(err), userId: user.id }, 'default sender not created');
    }
  },
};
