import { pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { sharedRedis } from '../src/queue/connection.js';
import { emailQueue } from '../src/queue/emailQueue.js';
import { SmtpSendError, type Mailer, type MailCredentials, type OutgoingMail, type SentMail, type SmtpFailureKind } from '../src/integrations/mailer.js';
import { userRepository } from '../src/repositories/userRepository.js';
import { senderRepository } from '../src/repositories/senderRepository.js';

export async function resetState() {
  await migrate();
  await pool.query('TRUNCATE users, sessions, senders, slack_installations, campaigns, emails, attachments CASCADE');
  await sharedRedis().flushdb();
  await emailQueue().obliterate({ force: true }).catch(() => undefined);
}

export async function createUserWithSender(email = 'owner@example.com') {
  const user = await userRepository.upsert({ googleId: null, email, name: 'Owner', avatarUrl: null });
  const sender = await senderRepository.create({
    userId: user.id,
    email: `sender-${Math.random().toString(36).slice(2, 8)}@ethereal.email`,
    displayName: 'Owner',
    smtpUser: 'u',
    smtpPass: 'p',
  });
  return { user, sender };
}

/** Records every send; can be told to be slow or to fail. */
export class FakeMailer implements Mailer {
  sent: OutgoingMail[] = [];
  sentAt: number[] = [];
  delayMs = 0;
  failNext = 0;
  /** How the next failures look to the worker; see classifySmtpError. */
  failKind: SmtpFailureKind = 'retryable';

  async send(_creds: MailCredentials, mail: OutgoingMail): Promise<SentMail> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failNext > 0) {
      this.failNext--;
      throw new SmtpSendError(this.failKind, `SMTP failure (${this.failKind})`);
    }
    this.sent.push(mail);
    this.sentAt.push(Date.now());
    return { messageId: mail.messageId, previewUrl: null };
  }

  close() {}
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000, stepMs = 50) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor timed out');
}
