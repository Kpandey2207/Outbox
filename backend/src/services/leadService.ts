import { parse } from 'csv-parse/sync';
import { env } from '../config/env.js';
import { badRequest } from '../utils/errors.js';
import { isValidEmail, normalizeRecipients } from './scheduling.js';

/**
 * Pulls email addresses out of an uploaded CSV. Uses an `email` column when there is a
 * header, otherwise any cell that looks like an address, so both "email,name" exports and
 * a bare one-address-per-line file work.
 */
export function parseLeadsCsv(buffer: Buffer) {
  if (buffer.subarray(0, 8192).includes(0)) throw badRequest('That file is not a CSV or text file');
  let rows: string[][];
  try {
    // Data only: nothing in the file is evaluated, and records, fields and rows are bounded.
    rows = parse(buffer, {
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: true,
      bom: true,
      max_record_size: 64 * 1024,
      to: env.MAX_RECIPIENTS_PER_CAMPAIGN + 2,
    });
  } catch (err) {
    const line = (err as { lines?: number }).lines;
    throw badRequest(`Could not read the CSV${line ? ` near line ${line}` : ''}. Check it is a plain CSV file.`);
  }
  if (rows.length === 0) throw badRequest('The CSV file is empty');
  if (rows.length > env.MAX_RECIPIENTS_PER_CAMPAIGN + 1) {
    throw badRequest(`The CSV has more than ${env.MAX_RECIPIENTS_PER_CAMPAIGN} rows; a campaign can have at most that many recipients`);
  }

  const header = rows[0]!.map((h) => h.toLowerCase());
  const emailCol = header.findIndex((h) => ['email', 'email address', 'e-mail', 'mail'].includes(h));
  const headerIsData = header.some((h) => isValidEmail(h));

  let candidates: string[];
  if (emailCol >= 0) {
    candidates = rows.slice(1).map((r) => r[emailCol] ?? '');
  } else {
    const data = headerIsData ? rows : rows.slice(1);
    candidates = data.flatMap((r) => r.filter((cell) => cell.includes('@')));
  }
  const result = normalizeRecipients(candidates);
  if (result.valid.length > env.MAX_RECIPIENTS_PER_CAMPAIGN) {
    throw badRequest(`A campaign can have at most ${env.MAX_RECIPIENTS_PER_CAMPAIGN} recipients`);
  }
  return {
    emails: result.valid,
    // Echoed back for display only; cut short so a hostile file cannot bloat the response.
    invalid: result.invalid.slice(0, 50).map((v) => v.slice(0, 100)),
    invalidCount: result.invalid.length,
    duplicates: result.duplicates,
  };
}
