/**
 * Rebuild the derived database index from the git-of-record working trees.
 *
 * This is the Phase B index-rebuild drill made runnable (ADR-0001): it proves the
 * database is disposable by reconstructing pages, versions, taxonomy, links,
 * assets, and search entirely from the canonical OKF Markdown files (and the
 * `assets/*.meta.json` descriptors) in the git working trees.
 *
 * Item identity (id, slug, owner, created_at) is recovered from the embedded
 * `e3_*` frontmatter, so backlinks/engagement/audit rows keyed on page_id stay
 * valid across the rebuild.
 *
 * Two modes:
 *
 *  - **Registry (default)** — every enabled row of `content_sources` (plan §7.4)
 *    is rebuilt in one pass, so an instance with dedicated topic repos gets all
 *    of them, not just one (plan §8.3, "Rebuild after DB loss"):
 *
 *      pnpm --filter @echozedlabs/server rebuild:git
 *
 *    After a *total* DB loss the registry is empty until boot repopulates it, so
 *    declare the sources under `sources:` in `knowledge-e3.config.yaml` (they are
 *    reconciled into the registry at startup) — or use the explicit mode below.
 *
 *  - **Explicit directory** — point it at one working tree:
 *
 *      GIT_MIRROR_DIR=./data/wiki-git pnpm --filter @echozedlabs/server rebuild:git
 *      DB_URL=./data/kp.sqlite pnpm --filter @echozedlabs/server rebuild:git ./data/wiki-git
 *
 *    This mode knows nothing about the registry, so it enumerates the canonical
 *    `concepts/` layout only. A source that imports ordinary Markdown through
 *    `include_globs` must be rebuilt through the registry mode above, which
 *    carries the globs and the import defaults.
 *
 * Pass --history to replay each item's full version chain from git commits
 * (rather than rebuilding only the current state).
 */
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { Kysely } from 'kysely';
import { AppModule } from '../src/app.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { ContentPathResolver } from '../src/storage/content-path.resolver.js';
import { IndexRebuildService, type RebuildRepo } from '../src/storage/index-rebuild.service.js';
import { globList, resolveLocalDir, SourceRegistryService } from '../src/sync/source-registry.service.js';

const args = process.argv.slice(2);
const explicitDir = args.find((a) => !a.startsWith('--')) ?? process.env['GIT_MIRROR_DIR'] ?? null;
const replayHistory = args.includes('--history');

// eslint-disable-next-line no-console
const log = console.log;

async function main(): Promise<void> {
  const ctx = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const auth = ctx.get(AuthService);
    const rebuild = ctx.get(IndexRebuildService);
    const system = await auth.ensureLocalSystemActor();

    const db = ctx.get<Kysely<Database>>(KYSELY);
    const repos = explicitDir
      ? explicitRepos(explicitDir)
      : await registryRepos(ctx.get(SourceRegistryService), ctx.get(ContentPathResolver).root, db);
    if (!repos) return; // nothing to rebuild from; already reported

    log(
      `[rebuild] rebuilding index from ${repos.length} working tree(s)` +
        (replayHistory ? ' (replaying full version history)' : ''),
    );
    for (const r of repos) {
      const globs = r.include?.length ? ` (import globs: ${r.include.join(', ')})` : '';
      log(`[rebuild]   ${r.sourceId ?? '(unregistered)'} -> ${r.dir}${globs}`);
    }

    const report = await rebuild.rebuildFromRepos(repos, { actorId: system.id, replayHistory });

    for (const [sourceId, pages] of await pagesBySource(db)) {
      log(`[rebuild]   ${sourceId}: ${pages} page(s)`);
    }
    log(
      `[rebuild] done: ${report.pages} page(s), ${report.versions} version(s), ${report.links} link(s), ` +
        `${report.images} asset(s)` +
        (report.imported ? `, ${report.imported} imported (non-OKF) file(s)` : '') +
        (report.reassignedOwners ? `, ${report.reassignedOwners} owner(s) reassigned` : ''),
    );
  } finally {
    await ctx.close();
  }
}

/** The pre-registry behaviour: one directory, named on argv or by GIT_MIRROR_DIR. */
function explicitRepos(dir: string): RebuildRepo[] {
  return [{ dir: isAbsolute(dir) ? dir : resolve(process.cwd(), dir) }];
}

/**
 * Every enabled source's working tree, carrying the registry fields the
 * enumeration needs: the `include`/`exclude` globs that decide which files are
 * items at all, the `default_type` / `default_status` an imported file that
 * names neither is given, the role, and the bound topic's name. Without these
 * a restore would enumerate only the canonical `concepts/` layout and lose
 * every glob-imported file (issue 94).
 *
 * Returns null — rather than an empty list — when there is nothing to rebuild
 * from, because `rebuildFromRepos([])` would wipe the derived tables and load
 * nothing back.
 */
async function registryRepos(
  registry: SourceRegistryService,
  root: string,
  db: Kysely<Database>,
): Promise<RebuildRepo[] | null> {
  const rows = (await registry.list()).filter((r) => r.enabled === 1);
  if (rows.length === 0) {
    log(
      '[rebuild] the source registry has no enabled sources, so there is nothing to rebuild from — ' +
        'the index was left untouched.\n' +
        '[rebuild] declare the repositories under `sources:` in knowledge-e3.config.yaml (they are ' +
        'reconciled into the registry at startup), or name one working tree explicitly:\n' +
        '[rebuild]   pnpm --filter @echozedlabs/server rebuild:git <dir>',
    );
    return null;
  }
  const repos: RebuildRepo[] = [];
  for (const row of rows) {
    const dir = resolveLocalDir(row.local_dir, root);
    if (!existsSync(dir)) {
      log(`[rebuild] skipping source ${row.id}: working tree ${dir} does not exist`);
      continue;
    }
    repos.push({
      dir,
      sourceId: row.id,
      include: globList(row.include_globs),
      exclude: globList(row.exclude_globs),
      defaultType: row.default_type,
      defaultStatus: row.default_status,
      role: row.role,
      topicName: await topicNameOf(db, row.space_id),
    });
  }
  if (repos.length === 0) {
    log(
      `[rebuild] none of the ${rows.length} enabled source(s) has a working tree on disk — ` +
        'the index was left untouched.',
    );
    return null;
  }
  return repos;
}

/** The bound topic's display name, read BEFORE the rebuild wipes and recreates it. */
async function topicNameOf(db: Kysely<Database>, spaceId: string | null): Promise<string | null> {
  if (!spaceId) return null;
  const row = await db.selectFrom('spaces').select('name').where('id', '=', spaceId).executeTakeFirst();
  return row?.name ?? null;
}

/** Per-source page counts, read back from the rebuilt index. */
async function pagesBySource(db: Kysely<Database>): Promise<[string, number][]> {
  const rows = await db
    .selectFrom('pages')
    .select(['source_id'])
    .select((eb) => eb.fn.countAll<number>().as('pages'))
    .groupBy('source_id')
    .orderBy('source_id')
    .execute();
  return rows.map((r) => [r.source_id ?? '(unregistered)', Number(r.pages)]);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[rebuild] failed:', err);
  process.exit(1);
});
