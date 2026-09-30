import { Client } from '@elastic/elasticsearch';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type { EmailStatus } from '../models/types.js';

export interface EmailDocument {
  id: string;
  userId: string;
  campaignId: string;
  senderEmail: string;
  recipient: string;
  subject: string;
  body: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  starred: boolean;
  archived: boolean;
  deleted: boolean;
}

export interface SearchQuery {
  userId: string;
  q: string;
  statuses: EmailStatus[];
  archived?: boolean;
  starredOnly?: boolean;
  from: number;
  size: number;
}

const INDEX = env.ELASTICSEARCH_INDEX;

let client: Client | null = null;
let indexReady: Promise<void> | null = null;

export function isSearchConfigured(): boolean {
  return Boolean(env.ELASTICSEARCH_URL);
}

function es(): Client {
  client ??= new Client({
    node: env.ELASTICSEARCH_URL!,
    ...(env.ELASTICSEARCH_API_KEY ? { auth: { apiKey: env.ELASTICSEARCH_API_KEY } } : {}),
    requestTimeout: 5_000,
    maxRetries: 1,
  });
  return client;
}

async function ensureIndex(): Promise<void> {
  indexReady ??= (async () => {
    const exists = await es().indices.exists({ index: INDEX });
    if (exists) return;
    await es().indices.create({
      index: INDEX,
      settings: {
        analysis: {
          analyzer: {
            email_address: { type: 'custom', tokenizer: 'uax_url_email', filter: ['lowercase'] },
          },
        },
      },
      mappings: {
        properties: {
          id: { type: 'keyword' },
          userId: { type: 'keyword' },
          campaignId: { type: 'keyword' },
          senderEmail: { type: 'keyword' },
          recipient: {
            type: 'text',
            analyzer: 'standard',
            fields: { exact: { type: 'text', analyzer: 'email_address' }, raw: { type: 'keyword' } },
          },
          subject: { type: 'text' },
          body: { type: 'text' },
          status: { type: 'keyword' },
          scheduledAt: { type: 'date' },
          sentAt: { type: 'date' },
          starred: { type: 'boolean' },
          archived: { type: 'boolean' },
          deleted: { type: 'boolean' },
        },
      },
    });
  })().catch((err) => {
    indexReady = null;
    throw err;
  });
  return indexReady;
}

export const searchIndex = {
  async indexMany(docs: EmailDocument[]): Promise<void> {
    if (!isSearchConfigured() || docs.length === 0) return;
    await ensureIndex();
    // Chunked: a 10k-recipient campaign would otherwise be one very large bulk request.
    for (let i = 0; i < docs.length; i += 1000) {
      const chunk = docs.slice(i, i + 1000);
      const operations = chunk.flatMap((d) => [{ index: { _index: INDEX, _id: d.id } }, d]);
      const res = await es().bulk({ operations, refresh: false });
      if (res.errors) logger.warn({ count: chunk.length }, 'some documents failed to index');
    }
  },

  async update(id: string, fields: Partial<Omit<EmailDocument, 'id' | 'userId'>>) {
    if (!isSearchConfigured()) return;
    await ensureIndex();
    await es().update({ index: INDEX, id, doc: fields, retry_on_conflict: 3 });
  },

  async search(query: SearchQuery): Promise<{ ids: string[]; total: number }> {
    await ensureIndex();
    const res = await es().search<EmailDocument>({
      index: INDEX,
      from: query.from,
      size: query.size,
      track_total_hits: true,
      _source: false,
      query: {
        bool: {
          filter: [
            { term: { userId: query.userId } },
            { terms: { status: query.statuses } },
            ...(query.archived === true ? [{ term: { archived: true } }] : []),
            ...(query.starredOnly ? [{ term: { starred: true } }] : []),
          ],
          // must_not rather than term:false, so documents indexed before these fields existed match.
          must_not: [
            { term: { deleted: true } },
            ...(query.archived === false ? [{ term: { archived: true } }] : []),
          ],
          must: [
            {
              multi_match: {
                query: query.q,
                fields: ['recipient^3', 'recipient.exact^4', 'subject^2', 'body'],
                type: 'best_fields',
                fuzziness: 'AUTO',
                prefix_length: 1,
              },
            },
          ],
        },
      },
      sort: ['_score', { scheduledAt: 'desc' }],
    });
    const total = typeof res.hits.total === 'number' ? res.hits.total : (res.hits.total?.value ?? 0);
    return { ids: res.hits.hits.map((h) => h._id!).filter(Boolean), total };
  },

  async close(): Promise<void> {
    if (client) await client.close();
    client = null;
    indexReady = null;
  },
};
