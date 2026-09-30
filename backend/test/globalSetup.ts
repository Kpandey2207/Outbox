import pg from 'pg';

/**
 * Creates the test database on first run, so `npm test` works on a fresh machine with only
 * the compose Postgres running. Migrations are applied by the tests themselves.
 */
export default async function setup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://outbox:outbox@localhost:5432/outbox_test');
  const name = url.pathname.slice(1);
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unexpected test database name: ${name}`);
  url.pathname = '/postgres';
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
}
