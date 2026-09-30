export type EmailStatus = 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled';

export interface User {
  id: string;
  google_id: string | null;
  email: string;
  name: string | null;
  avatar_url: string | null;
  password_hash: string | null;
  created_at: Date;
}

export interface Sender {
  id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  smtp_user: string;
  smtp_pass: string;
  created_at: Date;
}

export type PublicSender = Omit<Sender, 'smtp_user' | 'smtp_pass'>;

export interface SlackInstallation {
  user_id: string;
  team_id: string;
  team_name: string | null;
  bot_token: string;
  channel_id: string;
  channel_name: string | null;
  webhook_url: string | null;
  installed_at: Date;
}

export interface Campaign {
  id: string;
  user_id: string;
  sender_id: string;
  subject: string;
  body: string;
  start_at: Date;
  delay_between_ms: number;
  hourly_limit: number;
  total_recipients: number;
  idempotency_key: string | null;
  request_hash: Buffer | null;
  created_at: Date;
}

export interface Email {
  id: string;
  campaign_id: string;
  user_id: string;
  sender_id: string;
  recipient: string;
  subject: string;
  body: string;
  scheduled_at: Date;
  status: EmailStatus;
  attempts: number;
  reschedule_count: number;
  last_error: string | null;
  sending_started_at: Date | null;
  sent_at: Date | null;
  message_id: string | null;
  preview_url: string | null;
  starred: boolean;
  archived_at: Date | null;
  deleted_at: Date | null;
  claim_token: string | null;
  smtp_started_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** An email joined with the fields the worker needs to send and rate limit it. */
export interface EmailForSending extends Email {
  hourly_limit: number;
  delay_between_ms: number;
  sender_email: string;
  sender_display_name: string | null;
  /** The signed-in user who scheduled the email; shown as From. */
  owner_email: string;
  owner_name: string | null;
}

export interface EmailSendJobData {
  emailId: string;
  /** A throttle slot the limiter reserved for this email (epoch ms, Redis clock). */
  throttleSlot?: number;
  /** How many times the job waited out a Postgres/Redis outage before its claim. */
  infraDeferrals?: number;
}

export interface AttachmentMeta {
  id: string;
  campaign_id: string | null;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: Date;
}

export interface Attachment extends AttachmentMeta {
  user_id: string;
  data: Buffer;
}
