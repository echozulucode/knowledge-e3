import { describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import { lint } from '@echozedlabs/content-model';
import { makeKysely } from '../src/db/db.module.js';
import { migrateSqlite } from '../src/db/migrations.js';
import type { Database } from '../src/db/schema.js';
import { seedFirstMvpCorpus } from '../src/seed.js';
import { populateDemoCorpus } from '../scripts/populate-demo-corpus.js';

/**
 * The seed and the demo corpus write rows directly rather than through
 * `ContentCommandsService`, so the publish gate never sees them — deliberately:
 * they are operator-run bootstrap scripts, not an interactive door, and the gate
 * needs a live instance's vocabulary they are busy creating.
 *
 * That makes this the gate's stand-in for them. Every item they write as
 * `published` must be one the gate would have let an author publish (issue 98):
 * the same lint, with `published: true`, against the curated category catalog
 * as it stands once they have run. A seeded item that fails here is demo
 * content no author could reproduce through the product.
 */
describe('seeded published content passes the publish gate', () => {
  it('first-MVP seed and demo corpus: no error-severity diagnostic on any published item', async () => {
    const db: Kysely<Database> = makeKysely({ url: ':memory:', driver: 'sqlite' });
    try {
      await migrateSqlite(db);
      await db
        .insertInto('users')
        .values({
          id: 'u_seed',
          email: 'admin@local',
          username: 'admin',
          password_hash: 'x',
          role: 'admin',
          created_at: new Date().toISOString(),
          deleted_at: null,
        })
        .execute();
      await seedFirstMvpCorpus(db, 'u_seed');
      await populateDemoCorpus(db, 'u_seed');

      // The same vocabulary `ContentCommandsService.lintContext` builds: the
      // curated, un-archived catalog, by slug and by display name.
      const catalog = await db
        .selectFrom('primary_categories')
        .select(['slug', 'name'])
        .where('archived_at', 'is', null)
        .execute();
      const categories = catalog.flatMap((c) => [c.slug, c.name]);

      const published = await db
        .selectFrom('pages')
        .innerJoin('page_versions', 'page_versions.id', 'pages.current_version_id')
        .select(['pages.title as title', 'page_versions.raw_markdown as raw'])
        .where('pages.status', '=', 'published')
        .where('pages.deleted_at', 'is', null)
        .execute();
      expect(published.length).toBeGreaterThan(100);

      const failures = published
        .map(({ title, raw }) => ({
          title,
          errors: lint(raw, { known: { categories }, published: true })
            .filter((d) => d.severity === 'error')
            .map((d) => d.code),
        }))
        .filter((f) => f.errors.length > 0);
      expect(failures).toEqual([]);
    } finally {
      await db.destroy();
    }
  });
});
