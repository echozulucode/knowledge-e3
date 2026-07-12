/**
 * Rebuild the derived database index from the git-of-record working tree.
 *
 * This is the Phase B index-rebuild drill made runnable (ADR-0001): it proves the
 * database is disposable by reconstructing pages, versions, taxonomy, links, and
 * search entirely from the canonical OKF Markdown files in the git mirror.
 *
 * Item identity (id, slug, owner, created_at) is recovered from the embedded
 * `e3_*` frontmatter, so backlinks/engagement/audit rows keyed on page_id stay
 * valid across the rebuild.
 *
 *   GIT_MIRROR_DIR=./data/wiki-git pnpm --filter @echozedlabs/server rebuild:git
 *   DB_URL=./data/kp.sqlite pnpm --filter @echozedlabs/server rebuild:git ./data/wiki-git
 *
 * Pass --history to replay each item's full version chain from git commits
 * (rather than rebuilding only the current state).
 */
import 'reflect-metadata';
import { isAbsolute, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { IndexRebuildService } from '../src/storage/index-rebuild.service.js';

const args = process.argv.slice(2);
const inArg =
  args.find((a) => !a.startsWith('--')) ?? process.env['GIT_MIRROR_DIR'] ?? './data/wiki-git';
const replayHistory = args.includes('--history');

async function main(): Promise<void> {
  const dir = isAbsolute(inArg) ? inArg : resolve(process.cwd(), inArg);
  // eslint-disable-next-line no-console
  console.log(
    `[rebuild] rebuilding index from git working tree at ${dir}` +
      (replayHistory ? ' (replaying full version history)' : ''),
  );

  const ctx = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const auth = ctx.get(AuthService);
    const rebuild = ctx.get(IndexRebuildService);
    const system = await auth.ensureLocalSystemActor();

    const report = await rebuild.rebuildFromDir(dir, { actorId: system.id, replayHistory });
    // eslint-disable-next-line no-console
    console.log(
      `[rebuild] done: ${report.pages} page(s), ${report.versions} version(s), ${report.links} link(s)` +
        (report.reassignedOwners ? `, ${report.reassignedOwners} owner(s) reassigned` : ''),
    );
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[rebuild] failed:', err);
  process.exit(1);
});
