import type { Request, Response } from 'express';
import { currentUser } from '../middleware/auth.js';
import { campaignService } from '../services/campaignService.js';
import { parseLeadsCsv } from '../services/leadService.js';
import { badRequest } from '../utils/errors.js';
import type { CreateCampaignBody } from '../validation/schemas.js';

export const campaignController = {
  async create(req: Request, res: Response) {
    const body = res.locals.body as CreateCampaignBody;
    const key = req.header('Idempotency-Key')?.trim() || null;
    if (key && !/^[A-Za-z0-9_.:-]{1,200}$/.test(key)) {
      throw badRequest('Idempotency-Key must be 1-200 letters, digits or _ . : -');
    }
    const result = await campaignService.create({
      userId: currentUser(req).id,
      senderId: body.senderId,
      subject: body.subject,
      body: body.body,
      recipients: body.recipients,
      startAt: body.startAt,
      delayBetweenMs: Math.round(body.delayBetweenSeconds * 1000),
      hourlyLimit: body.hourlyLimit,
      attachmentIds: body.attachmentIds,
      idempotencyKey: key,
    });
    res.status(result.replayed ? 200 : 201).json({
      campaignId: result.campaign.id,
      scheduled: result.scheduled,
      firstSendAt: result.firstSendAt,
      lastSendAt: result.lastSendAt,
      replayed: result.replayed,
    });
  },

  parseLeads(req: Request, res: Response) {
    if (!req.file) throw badRequest('Attach a CSV file in the "file" field');
    res.json(parseLeadsCsv(req.file.buffer));
  },
};
