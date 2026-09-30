import { Router } from 'express';
import multer from 'multer';
import { env } from '../config/env.js';
import { attachmentController } from '../controllers/attachmentController.js';
import { authController } from '../controllers/authController.js';
import { campaignController } from '../controllers/campaignController.js';
import { emailController } from '../controllers/emailController.js';
import { senderController } from '../controllers/senderController.js';
import { slackController } from '../controllers/slackController.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/security.js';
import { validate } from '../middleware/validate.js';
import { LEADS_MAX_BYTES } from './limits.js';
import { createCampaignSchema, createSenderSchema, emailSignInSchema, idParamSchema, listEmailsSchema, updateEmailSchema } from '../validation/schemas.js';

// Uploads stay in memory (never written to disk, so nothing to clean up and no paths to
// traverse) and are capped before they are buffered. Only the expected field is accepted.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LEADS_MAX_BYTES, files: 1, fields: 5, parts: 6, fieldSize: 1024 },
});
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_ATTACHMENT_BYTES, files: env.MAX_ATTACHMENTS_PER_EMAIL, fields: 5, fieldSize: 1024 },
});

const MINUTE = 60;
const limits = {
  login: rateLimit({ name: 'login', windowSeconds: 5 * MINUTE, max: 20, by: 'ip' }),
  oauth: rateLimit({ name: 'oauth', windowSeconds: 5 * MINUTE, max: 30, by: 'ip' }),
  reads: rateLimit({ name: 'reads', windowSeconds: MINUTE, max: 600, by: 'user' }),
  writes: rateLimit({ name: 'writes', windowSeconds: MINUTE, max: 120, by: 'user' }),
  // Each creates a real Ethereal account at a third party.
  senders: rateLimit({ name: 'senders', windowSeconds: 60 * MINUTE, max: 10, by: 'user' }),
  campaigns: rateLimit({ name: 'campaigns', windowSeconds: 10 * MINUTE, max: 30, by: 'user' }),
  uploads: rateLimit({ name: 'uploads', windowSeconds: 10 * MINUTE, max: 60, by: 'user' }),
  slackTest: rateLimit({ name: 'slack-test', windowSeconds: 10 * MINUTE, max: 10, by: 'user' }),
};

/** Browser redirects for OAuth. Not under /api because the user's browser navigates here. */
export function authRoutes(): Router {
  const r = Router();
  r.get('/auth/config', authController.config);
  r.get('/auth/google', limits.oauth, authController.googleStart);
  r.get('/auth/google/callback', limits.oauth, authController.googleCallback);
  r.post('/auth/email', limits.login, validate('body', emailSignInSchema), authController.emailSignIn);
  r.post('/auth/dev-login', limits.login, authController.devLogin);
  r.post('/auth/logout', authController.logout);
  r.get('/integrations/slack/install', requireAuth, limits.oauth, slackController.install);
  // A browser that lost its session on the way back gets sent to sign in, not a JSON 401.
  r.get('/integrations/slack/callback', optionalAuth, limits.oauth, slackController.callback);
  return r;
}

export function apiRoutes(): Router {
  const r = Router();
  r.use(requireAuth);
  r.use((req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? limits.reads : limits.writes)(req, res, next));

  r.get('/me', authController.me);

  r.get('/senders', senderController.list);
  r.post('/senders', limits.senders, validate('body', createSenderSchema), senderController.create);

  r.post('/leads/parse', limits.uploads, upload.single('file'), campaignController.parseLeads);
  r.post('/attachments', limits.uploads, attachmentUpload.array('files'), attachmentController.upload);
  r.get('/attachments/:id', validate('params', idParamSchema), attachmentController.download);
  r.delete('/attachments/:id', validate('params', idParamSchema), attachmentController.remove);
  r.post('/campaigns', limits.campaigns, validate('body', createCampaignSchema), campaignController.create);

  r.get('/emails', validate('query', listEmailsSchema), emailController.list);
  r.get('/emails/counts', emailController.counts);
  r.get('/emails/:id', validate('params', idParamSchema), emailController.get);
  r.patch('/emails/:id', validate('params', idParamSchema), validate('body', updateEmailSchema), emailController.update);
  r.delete('/emails/:id', validate('params', idParamSchema), emailController.remove);

  r.post('/integrations/slack/test', limits.slackTest, slackController.test);
  r.delete('/integrations/slack', slackController.disconnect);
  return r;
}
