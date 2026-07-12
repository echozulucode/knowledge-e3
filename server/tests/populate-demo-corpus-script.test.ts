import { describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { makeKysely } from '../src/db/db.module.js';
import { migrateSqlite } from '../src/db/migrations.js';
import type { Database } from '../src/db/schema.js';
import { populateDemoCorpus } from '../scripts/populate-demo-corpus.js';

describe('populate demo corpus script', () => {
  it('idempotently creates 100 items across 20 topics and 10 main categories', async () => {
    const db: Kysely<Database> = makeKysely({ url: ':memory:', driver: 'sqlite' });
    try {
      await migrateSqlite(db);

      const first = await populateDemoCorpus(db);
      const second = await populateDemoCorpus(db);

      const [topics, categories, pages, pageCategories] = await Promise.all([
        db.selectFrom('spaces').select(['slug', 'name']).where('slug', 'like', 'demo-%').execute(),
        db.selectFrom('primary_categories').select(['slug', 'name']).where('slug', 'like', 'demo-%').execute(),
        db.selectFrom('pages').select(['id', 'title']).where('title', 'like', 'Demo Corpus:%').where('deleted_at', 'is', null).execute(),
        db.selectFrom('page_categories').select('category').distinct().where('category', 'like', 'demo-%').execute(),
      ]);

      expect(first).toEqual({ topicsCreated: 20, categoriesCreated: 10, itemsCreated: 100 });
      expect(second).toEqual({ topicsCreated: 0, categoriesCreated: 0, itemsCreated: 0 });
      expect(topics).toHaveLength(20);
      expect(categories).toHaveLength(10);
      expect(pages).toHaveLength(100);
      expect(pageCategories.map((category) => category.category).sort()).toEqual(categories.map((category) => category.slug).sort());
    } finally {
      await db.destroy();
    }
  });
});
