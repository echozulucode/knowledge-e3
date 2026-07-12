/**
 * Generate a deterministic sample dataset (topics, categories, groups, items)
 * and write it to a JSON file. No database needed.
 *
 *   pnpm --filter @echozedlabs/server data:generate
 *   SAMPLE_TOPICS=120 SAMPLE_CATEGORIES=80 SAMPLE_ITEMS=2000 pnpm --filter @echozedlabs/server data:generate
 *   pnpm --filter @echozedlabs/server data:generate ./data/my-dataset.json
 */
import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DEFAULT_COUNTS, generateDataset, type DatasetCounts } from './sample-data.js';

function intEnv(name: string, fallback: number): number {
  const value = process.env[name];
  const n = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const counts: DatasetCounts = {
  topics: intEnv('SAMPLE_TOPICS', DEFAULT_COUNTS.topics),
  categories: intEnv('SAMPLE_CATEGORIES', DEFAULT_COUNTS.categories),
  groups: intEnv('SAMPLE_GROUPS', DEFAULT_COUNTS.groups),
  items: intEnv('SAMPLE_ITEMS', DEFAULT_COUNTS.items),
  seed: intEnv('SAMPLE_SEED', DEFAULT_COUNTS.seed),
};

const out = process.argv[2] ?? process.env['DATASET_PATH'] ?? './data/sample-dataset.json';
const abs = isAbsolute(out) ? out : resolve(process.cwd(), out);
mkdirSync(dirname(abs), { recursive: true });

const dataset = generateDataset(counts);
writeFileSync(abs, JSON.stringify(dataset, null, 2));

// eslint-disable-next-line no-console
console.log(
  `[generate] ${dataset.counts.topics} topics, ${dataset.counts.categories} categories, ` +
    `${dataset.counts.groups} groups, ${dataset.counts.items} items -> ${abs}`,
);
