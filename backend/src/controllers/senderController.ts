import type { Request, Response } from 'express';
import { currentUser } from '../middleware/auth.js';
import { senderService } from '../services/senderService.js';

export const senderController = {
  async list(req: Request, res: Response) {
    res.json(await senderService.list(currentUser(req).id));
  },

  async create(req: Request, res: Response) {
    const { displayName } = res.locals.body as { displayName?: string };
    res.status(201).json(await senderService.create(currentUser(req), displayName));
  },
};
