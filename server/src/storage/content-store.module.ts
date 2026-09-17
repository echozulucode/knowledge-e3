import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { Global, Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { KYSELY } from '../db/db.module.js';
import type { Database } from '../db/schema.js';
import { contentRoot, isTest } from '../config/server-config.js';
import { ContentPathResolver } from './content-path.resolver.js';
import { ContentStoreRegistry } from './content-store.registry.js';

/**
 * The canonical-content seam (plan §7.2–7.3): where an item's file lives and
 * the store that writes it. Global (like DbModule) because the write path,
 * the mirror wiring, and the rebuild all need it, and it depends on nothing
 * but the database and config — so it cannot form an import cycle.
 */
@Global()
@Module({
  providers: [
    {
      provide: ContentPathResolver,
      useFactory: (db: Kysely<Database>) => new ContentPathResolver(resolveRoot(), db),
      inject: [KYSELY],
    },
    ContentStoreRegistry,
  ],
  exports: [ContentPathResolver, ContentStoreRegistry],
})
export class ContentStoreModule {}

/**
 * Under test with no explicit root, each app instance gets its own directory
 * under the per-process temp root: the suite runs every test in one process
 * against a fresh in-memory DB, so a shared tree would make a slug from one
 * test collide with the same slug's file from an earlier one.
 */
function resolveRoot(): string {
  const root = contentRoot();
  if (!isTest() || process.env['CONTENT_ROOT'] || process.env['GIT_MIRROR_ROOT']) return root;
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, 'app-'));
}
