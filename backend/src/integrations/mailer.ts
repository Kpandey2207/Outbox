import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { redactSecrets } from '../utils/errors.js';

/**
 * How a failed send may be handled, decided from how far the SMTP conversation got:
 *   retryable  the server said "not now" (4xx), or we never reached DATA: nothing was sent.
 *   permanent  the server refused the message (5xx). Retrying cannot help.
 *   unknown    the connection broke after the message was handed over. The server may have
 *              accepted it, so retrying could deliver it twice. Never retried.
 */
export type SmtpFailureKind = 'retryable' | 'permanent' | 'unknown';

export class SmtpSendError extends Error {
  constructor(
    public readonly kind: SmtpFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'SmtpSendError';
  }
}

export function classifySmtpError(err: unknown, dataSent: boolean): SmtpSendError {
  const e = err as { code?: string; responseCode?: number; response?: string };
  if (typeof e.responseCode === 'number') {
    // The server answered with a refusal, so it did not take the message, even after DATA.
    const reply = redactSecrets(String(e.response ?? e.responseCode)).replace(/\s+/g, ' ').slice(0, 200);
    return e.responseCode >= 500
      ? new SmtpSendError('permanent', `The mail server refused this email: ${reply}`)
      : new SmtpSendError('retryable', `The mail server asked to try later: ${reply}`);
  }
  if (!dataSent) {
    const what = e.code === 'EAUTH' ? 'sign in to the mail server' : 'reach the mail server';
    return new SmtpSendError('retryable', `Could not ${what} (${e.code ?? 'error'})`);
  }
  return new SmtpSendError(
    'unknown',
    'Lost the connection to the mail server while sending; delivery outcome unknown, not retried to avoid a duplicate',
  );
}

/**
 * A nodemailer logger that records nothing but one fact: whether the DATA command went out.
 * `transactionLog` makes nodemailer report each client command (never the message body,
 * and AUTH lines are masked), which is what classifySmtpError needs.
 */
function phaseLogger(onData: () => void) {
  const ignore = () => undefined;
  return {
    level: ignore,
    trace: ignore,
    info: ignore,
    warn: ignore,
    error: ignore,
    fatal: ignore,
    debug: (entry: { tnx?: string } | undefined, message?: unknown) => {
      if (entry?.tnx === 'client' && typeof message === 'string' && message.trim().toUpperCase() === 'DATA') onData();
    },
  };
}

export interface MailCredentials {
  senderId: string;
  smtpUser: string;
  smtpPass: string;
}

export interface OutgoingMail {
  /** From header the recipient sees: the signed-in user, e.g. "Gray Scholar <gray@gmail.com>". */
  from: string;
  /** Address the SMTP account actually sends as (MAIL FROM and the Sender header). */
  envelopeFrom: string;
  replyTo?: string;
  to: string;
  subject: string;
  html: string;
  /** Deterministic Message-ID so the same email always carries the same identity. */
  messageId: string;
  attachments?: MailAttachment[];
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface SentMail {
  messageId: string;
  previewUrl: string | null;
}

export interface Mailer {
  send(creds: MailCredentials, mail: OutgoingMail): Promise<SentMail>;
  close(): void;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Nodemailer over SMTP (Ethereal by default). One connection per message rather than a pool:
 * sends are already spaced out by the throttle, and a private connection lets us know
 * exactly how far a failed conversation got (see classifySmtpError).
 */
export class SmtpMailer implements Mailer {
  async send(creds: MailCredentials, mail: OutgoingMail): Promise<SentMail> {
    let dataSent = false;
    const transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      // Refuse to send credentials over plain text when the server offers STARTTLS.
      requireTLS: !env.SMTP_SECURE && env.SMTP_HOST !== 'localhost' && env.SMTP_HOST !== '127.0.0.1',
      auth: { user: creds.smtpUser, pass: creds.smtpPass },
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      transactionLog: true,
      logger: phaseLogger(() => (dataSent = true)) as never,
    });
    let info;
    try {
      info = await transport.sendMail({
        from: mail.from,
        // The mail is relayed by the sender's Ethereal account on the user's behalf. The Sender
        // header and SMTP envelope say so honestly, while From shows who wrote it.
        sender: mail.envelopeFrom,
        envelope: { from: mail.envelopeFrom, to: mail.to },
        ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
        to: mail.to,
        subject: mail.subject,
        html: mail.html,
        text: htmlToText(mail.html),
        messageId: mail.messageId,
        ...(mail.attachments?.length
          ? { attachments: mail.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })) }
          : {}),
      });
    } catch (err) {
      throw classifySmtpError(err, dataSent);
    } finally {
      transport.close();
    }
    const preview = nodemailer.getTestMessageUrl(info);
    return { messageId: info.messageId ?? mail.messageId, previewUrl: preview || null };
  }

  close(): void {
    // Connections are per message and already closed.
  }
}

/** Gets SMTP credentials for a new sender: the fixed account from env, or a fresh Ethereal one. */
export async function provisionEtherealAccount(): Promise<{ user: string; pass: string }> {
  if (env.ETHEREAL_USER && env.ETHEREAL_PASS) {
    return { user: env.ETHEREAL_USER, pass: env.ETHEREAL_PASS };
  }
  const account = await nodemailer.createTestAccount();
  return { user: account.user, pass: account.pass };
}
