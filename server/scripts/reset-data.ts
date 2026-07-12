/**
 * Empty ALL content and taxonomy (pages, versions, topics, categories, groups,
 * tags, links, audit, etc.). Keeps the admin/user accounts and the built-in
 * default topic so the app stays usable.
 *
 *   pnpm --filter @echozedlabs/server data:reset
 *   DB_URL=./data/kp.sqlite pnpm --filter @echozedlabs/server data:reset
 */
import 'reflect-metadata';
import { makeKysely } from '../src/db/db.module.js';
import { migrateSqlite } from '../src/db/migrations.js';
import { resetContent } from './sample-data.js';

const DB_URL = process.env['DB_URL'] ?? './data/kp.sqlite';

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`[reset] DB_URL=${DB_URL}`);
  const db = makeKysely({ url: DB_URL, driver: 'sqlite' });
  try {
    await migrateSqlite(db);
    await resetContent(db);
    // eslint-disable-next-line no-console
    console.log('[reset] emptied all content + taxonomy (kept user accounts + the default topic).');
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[reset] failed:', err);
  process.exit(1);
});
