import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { LEADS_MAX_BYTES } from '../routes/limits.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError, redactSecrets, safeError } from '../utils/errors.js';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? req.path.endsWith('/leads/parse')
          ? `The list is larger than ${mb(LEADS_MAX_BYTES)} MB`
          : `A file is larger than ${mb(env.MAX_ATTACHMENT_BYTES)} MB`
        : err.code === 'LIMIT_FILE_COUNT'
          ? `Attach at most ${env.MAX_ATTACHMENTS_PER_EMAIL} files`
          : 'The upload was not accepted';
    res.status(400).json({ error: { code: 'bad_upload', message } });
    return;
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: { code: 'bad_json', message: 'Request body is not valid JSON' } });
    return;
  }
  // Logged without the raw object (third-party errors can carry credentials); the client
  // only ever gets a generic message, never a stack trace, query or connection detail.
  logger.error({ err: safeError(err), stack: err instanceof Error && err.stack ? redactSecrets(err.stack) : undefined, path: req.path }, 'unhandled error');
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
}
