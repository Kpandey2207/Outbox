import type { Request, Response } from 'express';
import { currentUser } from '../middleware/auth.js';
import type { AttachmentMeta } from '../models/types.js';
import { INLINE_IMAGE_TYPES, attachmentService } from '../services/attachmentService.js';

export function serializeAttachment(a: AttachmentMeta) {
  return { id: a.id, filename: a.filename, contentType: a.content_type, size: a.size_bytes };
}

export const attachmentController = {
  async upload(req: Request, res: Response) {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const saved = await attachmentService.upload(currentUser(req).id, files);
    res.status(201).json({ items: saved.map(serializeAttachment) });
  },

  async download(req: Request, res: Response) {
    const { id } = res.locals.params as { id: string };
    const a = await attachmentService.get(currentUser(req).id, id);
    const inline = INLINE_IMAGE_TYPES.has(a.content_type);
    res.setHeader('Content-Type', a.content_type);
    res.setHeader('Content-Length', String(a.data.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Even if a file were ever opened as a page, it could run nothing and reach nothing.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
    );
    res.end(a.data);
  },

  async remove(req: Request, res: Response) {
    const { id } = res.locals.params as { id: string };
    await attachmentService.remove(currentUser(req).id, id);
    res.status(204).end();
  },
};
