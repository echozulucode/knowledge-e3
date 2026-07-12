/**
 * Export all Knowledge E3 content to an Open Knowledge Format (OKF) bundle on disk.
 *
 * This is the first concrete increment of the git-of-record direction (see
 * docs/llm-wiki-study/implementation-plan.md and docs/okf-study/): a read-only
 * export that turns every page into an OKF concept document, reusing the @echozedlabs/codec
 * parser and the @echozedlabs/okf builder. It does not modify any content.
 *
 *   pnpm --filter @echozedlabs/server export:okf                 # → ./data/okf-export
 *   pnpm --filter @echozedlabs/server export:okf ./data/my-okf   # custom output directory
 *   pnpm --filter @echozedlabs/server export:okf --space=physics # only one topic
 *   DB_URL=./data/kp.sqlite pnpm --filter @echozedlabs/server export:okf
 */
import 'reflect-metadata';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { buildBundle, validateBundle, type PageInput } from '@echozedlabs/okf';
import { makeKysely } from '../src/db/db.module.js';
import { migrateSqlite } from '../src/db/migrations.js';

const DB_URL = process.env['DB_URL'] ?? './data/kp.sqlite';
const args = process.argv.slice(2);
const outArg = args.find((a) => !a.startsWith('--')) ?? process.env['OKF_OUT'] ?? './data/okf-export';
const spaceArg =
  args.find((a) => a.startsWith('--space='))?.slice('--space='.length) ?? process.env['OKF_SPACE'];

async function main(): Promise<void> {
  const outDir = isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg);
  // eslint-disable-next-line no-console
  console.log(`[okf] DB_URL=${DB_URL} out=${outDir}`);

  const db = makeKysely({ url: DB_URL, driver: 'sqlite' });
  try {
    await migrateSqlite(db);

    let query = db
      .selectFrom('pages as p')
      .leftJoin('page_versions as v', 'v.id', 'p.current_version_id')
      .leftJoin('spaces as s', 's.id', 'p.space_id')
      .where('p.deleted_at', 'is', null);

    if (spaceArg && spaceArg.trim()) {
      const ref = spaceArg.trim();
      query = query.where((eb) => eb.or([eb('s.id', '=', ref), eb('s.slug', '=', ref)]));
      // eslint-disable-next-line no-console
      console.log(`[okf] space filter: ${ref}`);
    }

    const rows = await query
      .select([
        'p.id as id',
        'p.slug as slug',
        'p.title as title',
        'p.status as status',
        'p.created_at as created_at',
        'p.updated_at as updated_at',
        's.slug as space_slug',
        'v.raw_markdown as raw_markdown',
      ])
      .execute();

    const pages: PageInput[] = [];
    for (const r of rows) {
      if (!r.raw_markdown) continue; // page without a current version has no content to export
      const [tags, categories, groups] = await Promise.all([
        db.selectFrom('page_tags').select('tag').where('page_id', '=', r.id).execute(),
        db.selectFrom('page_categories').select('category').where('page_id', '=', r.id).execute(),
        db
          .selectFrom('page_groups as pg')
          .innerJoin('groups as g', 'g.id', 'pg.group_id')
          .select('g.slug as slug')
          .where('pg.page_id', '=', r.id)
          .execute(),
      ]);
      pages.push({
        id: r.id,
        slug: r.slug,
        title: r.title,
        status: r.status,
        space: r.space_slug ?? null,
        tags: tags.map((t) => t.tag),
        categories: categories.map((c) => c.category),
        groups: groups.map((g) => g.slug),
        rawMarkdown: r.raw_markdown,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      });
    }

    const bundle = buildBundle(pages, {
      bundleTitle: 'Knowledge E3',
      bundleDescription: 'Exported from Knowledge E3 in Open Knowledge Format (OKF v0.1).',
    });

    // Fresh export: clear a prior export dir so deleted pages don't linger.
    rmSync(outDir, { recursive: true, force: true });
    for (const file of bundle.files) {
      const abs = join(outDir, file.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.content, 'utf8');
    }

    const report = validateBundle(bundle);
    // eslint-disable-next-line no-console
    console.log(
      `[okf] wrote ${bundle.files.length} files (${report.conceptCount} concepts) to ${outDir}`,
    );
    if (report.conformant) {
      // eslint-disable-next-line no-console
      console.log('[okf] conformance: OK (OKF v0.1)');
    } else {
      // eslint-disable-next-line no-console
      console.error(`[okf] conformance: ${report.issues.length} issue(s):`);
      for (const issue of report.issues) {
        // eslint-disable-next-line no-console
        console.error(`  - [${issue.severity}] ${issue.path}: ${issue.message}`);
      }
      process.exitCode = 1;
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[okf] export failed:', err);
  process.exit(1);
});
