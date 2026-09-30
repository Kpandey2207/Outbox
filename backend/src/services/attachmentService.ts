import path from 'node:path';
import type pg from 'pg';
import { env } from '../config/env.js';
import { advisoryXactLock, withTransaction } from '../db/pool.js';
import type { Attachment, AttachmentMeta } from '../models/types.js';
import { attachmentRepository } from '../repositories/attachmentRepository.js';
import { badRequest, notFound } from '../utils/errors.js';

/**
 * What may be attached. SVG and HTML are left out on purpose: they can carry script, and
 * the dashboard previews images inline.
 */
const ALLOWED: Record<string, string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'application/pdf': ['.pdf'],
  'text/plain': ['.txt'],
  'text/csv': ['.csv'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-powerpoint': ['.ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'application/zip': ['.zip'],
};

const BY_EXTENSION = new Map(Object.entries(ALLOWED).flatMap(([type, exts]) => exts.map((e) => [e, type] as const)));

/** Images the dashboard may render inline; everything else is served as a download. */
export const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

function cleanFilename(name: string): string {
  const base = path.basename(name).replace(/[\u0000-\u001f"\\/]/g, '').trim();
  return (base || 'attachment').slice(0, 200);
}

/**
 * File signatures for the types whose content we can check. The browser's MIME type is never
 * trusted; the type comes from the extension and, where the format has one, must match the
 * file's first bytes. That stops e.g. an HTML page renamed to .png from being stored as an image.
 */
const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'application/zip': isZip,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': isZip,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': isZip,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': isZip,
  // Legacy Office files are OLE compound documents.
  'application/msword': isOle,
  'application/vnd.ms-excel': isOle,
  'application/vnd.ms-powerpoint': isOle,
  // Text must actually be text: no NUL bytes in the first few KB.
  'text/plain': (b) => !b.subarray(0, 8192).includes(0),
  'text/csv': (b) => !b.subarray(0, 8192).includes(0),
};

function isZip(b: Buffer): boolean {
  return b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06);
}

function isOle(b: Buffer): boolean {
  return b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
}

function resolveType(file: UploadedFile): string {
  const ext = path.extname(file.originalname).toLowerCase();
  const byExt = BY_EXTENSION.get(ext);
  if (!byExt) throw badRequest(`${cleanFilename(file.originalname)}: this file type can't be attached`);
  const matches = SIGNATURES[byExt];
  if (matches && !matches(file.buffer)) {
    throw badRequest(`${cleanFilename(file.originalname)} does not look like a ${ext.slice(1).toUpperCase()} file`);
  }
  return byExt;
}

export const attachmentService = {
  async upload(userId: string, files: UploadedFile[]): Promise<AttachmentMeta[]> {
    if (files.length === 0) throw badRequest('Choose at least one file');
    for (const f of files) {
      if (f.buffer.length === 0) throw badRequest(`${cleanFilename(f.originalname)} is empty`);
      if (f.buffer.length > env.MAX_ATTACHMENT_BYTES) {
        throw badRequest(`${cleanFilename(f.originalname)} is larger than ${Math.round(env.MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`);
      }
    }
    const typed = files.map((f) => ({ file: f, contentType: resolveType(f) }));
    await attachmentRepository.deleteStaleUnlinked(userId);
    // Unscheduled uploads are bounded per user. The per-user lock stops parallel uploads from
    // all passing the count.
    return withTransaction(async (client) => {
      await advisoryXactLock(client, `uploads:${userId}`);
      const pending = await attachmentRepository.countUnlinked(userId, client);
      if (pending + files.length > env.MAX_PENDING_UPLOADS) {
        throw badRequest('Too many files waiting to be sent. Remove some or schedule the email first.');
      }
      const out: AttachmentMeta[] = [];
      for (const { file, contentType } of typed) {
        out.push(
          await attachmentRepository.create(
            { userId, filename: cleanFilename(file.originalname), contentType, data: file.buffer },
            client,
          ),
        );
      }
      return out;
    });
  },

  async get(userId: string, id: string): Promise<Attachment> {
    const a = await attachmentRepository.findForUser(userId, id);
    if (!a) throw notFound('Attachment not found');
    return a;
  },

  async remove(userId: string, id: string): Promise<void> {
    if (!(await attachmentRepository.deleteUnlinked(userId, id))) {
      throw notFound('Attachment not found, or already sent with a campaign');
    }
  },

  /** Called inside the campaign transaction so a campaign never exists with half its files. */
  async linkToCampaign(client: pg.PoolClient, userId: string, campaignId: string, ids: string[]): Promise<AttachmentMeta[]> {
    const unique = [...new Set(ids)];
    if (unique.length > env.MAX_ATTACHMENTS_PER_EMAIL) {
      throw badRequest(`Attach at most ${env.MAX_ATTACHMENTS_PER_EMAIL} files`);
    }
    const linked = await attachmentRepository.linkToCampaign(client, userId, campaignId, unique);
    if (linked.length !== unique.length) throw badRequest('Some attachments are missing or were already used; upload them again');
    const total = linked.reduce((sum, a) => sum + a.size_bytes, 0);
    if (total > env.MAX_ATTACHMENTS_TOTAL_BYTES) {
      throw badRequest(`Attachments add up to more than ${Math.round(env.MAX_ATTACHMENTS_TOTAL_BYTES / 1024 / 1024)} MB`);
    }
    return linked;
  },
};
