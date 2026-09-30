import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * AES-256-GCM for third-party credentials kept in Postgres (Slack bot tokens, SMTP
 * passwords), so a database dump or backup alone does not hand them out.
 *
 * Stored form: `enc:v1:<base64 iv|tag|ciphertext>`. Values without the prefix are rows
 * written before encryption existed and are returned as they are.
 */
const PREFIX = 'enc:v1:';

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = env.DATA_ENCRYPTION_KEY;
  if (raw) {
    const decoded = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (decoded.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes, as 64 hex characters or base64');
    cachedKey = decoded;
  } else {
    cachedKey = Buffer.from(hkdfSync('sha256', env.JWT_SECRET, 'outbox', 'data-encryption-key', 32));
  }
  return cachedKey;
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function openSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}
