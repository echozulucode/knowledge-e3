/**
 * Import a sample dataset into the database. Reads the JSON written by
 * data:generate (or generates a default one if the file is missing).
 *
 *   pnpm --filter @echozedlabs/server data:import            # import (append) the dataset
 *   pnpm --filter @echozedlabs/server data:import --reset     # empty first, then import
 *   DB_URL=./data/kp.sqlite pnpm --filter @echozedlabs/server data:import ./data/sample-dataset.json --reset
 */
import 'reflect-metadata';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { makeKysely } from '../src/db/db.module.js';
import { migrateSqlite } from '../src/db/migrations.js';
import {
  DEFAULT_COUNTS,
  ensureAdmin,
  generateDataset,
  importDataset,
  resetContent,
  type SampleDataset,
} from './sample-data.js';

const DB_URL = process.env['DB_URL'] ?? './data/kp.sqlite';
const args = process.argv.slice(2);
const reset = args.includes('--reset') || process.env['RESET'] === '1';
const pathArg = args.find((a) => !a.startsWith('--')) ?? process.env['DATASET_PATH'] ?? './data/sample-dataset.json';

async function main(): Promise<void> {
  const datasetPath = isAbsolute(pathArg) ? pathArg : resolve(process.cwd(), pathArg);

  let dataset: SampleDataset;
  if (existsSync(datasetPath)) {
    dataset = JSON.parse(readFileSync(datasetPath, 'utf8')) as SampleDataset;
    // eslint-disable-next-line no-console
    console.log(`[import] loaded dataset ${datasetPath}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[import] no dataset at ${datasetPath}; generating a default one in-memory.`);
    dataset = generateDataset(DEFAULT_COUNTS);
  }

  if (DB_URL !== ':memory:') {
    const abs = isAbsolute(DB_URL) ? DB_URL : resolve(process.cwd(), DB_URL);
    mkdirSync(dirname(abs), { recursive: true });
  }

  // eslint-disable-next-line no-console
  console.log(`[import] DB_URL=${DB_URL} reset=${reset}`);
  const db = makeKysely({ url: DB_URL, driver: 'sqlite' });
  try {
    await migrateSqlite(db);
    if (reset) {
      await resetContent(db);
      // eslint-disable-next-line no-console
      console.log('[import] reset: emptied existing content + taxonomy.');
    }
    const adminId = await ensureAdmin(db);
    const started = Date.now();
    const result = await importDataset(db, adminId, dataset);
    // eslint-disable-next-line no-console
    console.log(
      `[import] done in ${Date.now() - started}ms: ${result.topics} topics, ${result.categories} categories, ` +
        `${result.groups} groups, ${result.items} items created.`,
    );
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[import] failed:', err);
  process.exit(1);
});
