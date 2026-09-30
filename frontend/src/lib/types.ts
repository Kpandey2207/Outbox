export type EmailStatus = "scheduled" | "sending" | "sent" | "failed" | "cancelled";
export type EmailView = "scheduled" | "sent" | "starred" | "archived";

export interface Sender {
  id: string;
  email: string;
  display_name: string | null;
}

export interface Me {
  user: { id: string; email: string; name: string | null; avatarUrl: string | null };
  senders: Sender[];
  slack: { connected: boolean; teamName?: string | null; channelName?: string | null };
  features: { slack: boolean; search: boolean; queueDashboard: boolean };
  /** Server caps; campaigns outside them are refused. */
  limits: { maxHourlyLimit: number; minDelaySeconds: number; maxRecipients: number };
}

export interface Email {
  id: string;
  campaignId: string;
  from: string;
  fromName: string | null;
  /** Ethereal account that relayed the email. */
  via: string;
  to: string;
  subject: string;
  body: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  attempts: number;
  rescheduleCount: number;
  lastError: string | null;
  previewUrl: string | null;
  starred: boolean;
  archivedAt: string | null;
  createdAt: string;
  /** Only on the single-email endpoint. */
  attachments?: Attachment[];
}

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface EmailPage {
  items: Email[];
  total: number;
  page: number;
  pageSize: number;
  engine: "elasticsearch" | "postgres";
}

export interface ParsedLeads {
  emails: string[];
  invalid: string[];
  invalidCount: number;
  duplicates: number;
}

export interface CreateCampaignInput {
  senderId: string;
  subject: string;
  body: string;
  recipients: string[];
  startAt: string;
  delayBetweenSeconds: number;
  hourlyLimit: number;
  attachmentIds: string[];
}

export interface CreateCampaignResult {
  campaignId: string;
  scheduled: number;
  firstSendAt: string;
  lastSendAt: string;
  replayed: boolean;
}
