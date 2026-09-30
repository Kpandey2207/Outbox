import { logger } from '../config/logger.js';
import { safeError } from '../utils/errors.js';
import { pool } from '../db/pool.js';
import { isSearchConfigured, searchIndex } from '../integrations/elasticsearch.js';
import { emailRepository } from '../repositories/emailRepository.js';
import { toDocument } from '../services/searchService.js';

/** Rebuilds the Elasticsearch index from Postgres, the source of truth. */
async function main() {
  if (!isSearchConfigured()) throw new Error('ELASTICSEARCH_URL is not set');
  let afterId: string | null = null;
  let total = 0;
  for (;;) {
    const rows = await emailRepository.allPage(afterId, 1000);
    if (rows.length === 0) break;
    await searchIndex.indexMany(rows.map((r) => toDocument(r, r.sender_email)));
    total += rows.length;
    afterId = rows[rows.length - 1]!.id;
  }
  logger.info({ total }, 'reindex complete');
  await searchIndex.close();
  await pool.end();
}

main().catch((err) => {
  logger.error({ err: safeError(err) }, 'reindex failed');
  process.exit(1);
});
