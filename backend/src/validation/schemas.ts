import { z } from 'zod';
import { env } from '../config/env.js';

const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 3600 * 1000;

export const createCampaignSchema = z.object({
  senderId: z.string().uuid(),
  subject: z.string().trim().min(1, 'Subject is required').max(500),
  body: z.string().trim().min(1, 'Body is required').max(100_000),
  recipients: z.array(z.string().max(320)).min(1, 'Add at least one recipient').max(env.MAX_RECIPIENTS_PER_CAMPAIGN),
  startAt: z.coerce
    .date()
    .refine((d) => d.getTime() <= Date.now() + MAX_SCHEDULE_AHEAD_MS, 'Schedule at most a year ahead'),
  delayBetweenSeconds: z.coerce.number().min(0).max(3600),
  hourlyLimit: z.coerce.number().int().min(1).max(10_000),
  attachmentIds: z.array(z.string().uuid()).max(env.MAX_ATTACHMENTS_PER_EMAIL).default([]),
});
export type CreateCampaignBody = z.infer<typeof createCampaignSchema>;

export const listEmailsSchema = z.object({
  status: z.enum(['scheduled', 'sent', 'starred', 'archived']).default('scheduled'),
  /** Narrows the mailbox to one delivery status (the list's Filter menu). */
  only: z.enum(['scheduled', 'sending', 'sent', 'failed']).optional(),
  q: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v ? v : undefined)),
  // Bounded so a request cannot ask the database (or Elasticsearch) to skip millions of rows.
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListEmailsQuery = z.infer<typeof listEmailsSchema>;

export const updateEmailSchema = z
  .object({ starred: z.boolean().optional(), archived: z.boolean().optional() })
  .refine((v) => v.starred !== undefined || v.archived !== undefined, 'Nothing to update');
export type UpdateEmailBody = z.infer<typeof updateEmailSchema>;

export const idParamSchema = z.object({ id: z.string().uuid() });

export const createSenderSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
});

export const emailSignInSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});
