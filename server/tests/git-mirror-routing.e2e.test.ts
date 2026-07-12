import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { validateBundle } from '@echozedlabs/okf';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { ItemsService, type ItemView } from '../src/items/items.service.js';
import { RepoConfigService } from '../src/storage/repo-config.service.js';
import { RoutingRevisionMirror } from '../src/storage/routing-revision-mirror.adapter.js';
import type { RevisionMirrorEvent } from '../src/storage/revision-mirror.port.js';

/** Read every .md file under a dir (skipping .git) as {path, content}. */
function readBundle(root: string, sub = ''): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const entry of readdirSync(join(root, sub), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const rel = sub ? `${sub}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...readBundle(root, rel));
    else if (entry.name.endsWith('.md')) out.push({ path: rel, content: readFileSync(join(root, rel), 'utf8') });
  }
  return out;
}

/**
 * Topic-first, hybrid routing (ADR-0001): un-bound topics live as subtrees in the
 * shared main repo; a topic bound to a dedicated repo (space_repos) routes to its
 * own repo — re-resolved per write, so binding takes effect without a restart.
 */
describe('RoutingRevisionMirror (topic-subtree, hybrid) e2e', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let items: ItemsService;
  let repos: RepoConfigService;
  let adminId: string;
  let root: string;
  let mirror: RoutingRevisionMirror;

  beforeEach(async () => {
    app = await makeApp();
    ({ userId: adminId } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
    items = app.get(ItemsService);
    repos = app.get(RepoConfigService);
    root = mkdtempSync(join(tmpdir(), 'e3-mirror-root-'));
    mirror = new RoutingRevisionMirror(root, db, { quietMs: 20, maxMs: 50 });
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  function eventFrom(item: ItemView): RevisionMirrorEvent {
    return {
      itemId: item.id,
      versionId: item.current_version_id ?? 'unknown',
      versionToken: item.version_token,
      actorId: adminId,
      title: item.title,
      slug: item.slug,
      rawMarkdown: item.raw_markdown,
      status: item.status,
      spaceId: item.space_id,
      ownerId: item.owner_id,
      tags: item.tags,
      categories: item.categories,
      groups: item.groups,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    };
  }

  it('routes un-bound topics into the main repo as subtrees', async () => {
    const physics = await items.create(adminId, {
      title: 'Quark', body: 'p', status: 'published', frontmatter: { topic: 'Physics' },
    });
    const music = await items.create(adminId, {
      title: 'Sonata', body: 'm', status: 'published', frontmatter: { topic: 'Music' },
    });
    const loose = await items.create(adminId, { title: 'Scratch', body: 'n', status: 'published' });

    await mirror.afterItemVersionPersisted(eventFrom(physics));
    await mirror.afterItemVersionPersisted(eventFrom(music));
    await mirror.afterItemVersionPersisted(eventFrom(loose));
    await mirror.flush();

    const main = join(root, 'main');
    expect(existsSync(join(main, '.git'))).toBe(true);
    // Each topic is a subtree; the topicless item lands under `default`.
    expect(existsSync(join(main, 'physics', 'concepts', `${physics.slug}.md`))).toBe(true);
    expect(existsSync(join(main, 'music', 'concepts', `${music.slug}.md`))).toBe(true);
    expect(existsSync(join(main, 'default', 'concepts', `${loose.slug}.md`))).toBe(true);

    // The shared repo is one conformant bundle with a root index over all topics.
    const index = readFileSync(join(main, 'index.md'), 'utf8');
    expect(index).toMatch(/okf_version: "0\.1"/);
    expect(index).toContain('(/physics/concepts/');
    const report = validateBundle({ files: readBundle(main) });
    expect(report.conformant).toBe(true);
    expect(report.conceptCount).toBe(3);
  });

  it('hot-reloads a topic binding: main subtree → dedicated repo, no restart', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'e3-dedicated-')) + '/sales.git';
    execFileSync('git', ['init', '--bare', bare]);

    const item = await items.create(adminId, {
      title: 'Pipeline', body: 'v1', status: 'published', frontmatter: { topic: 'Sales' },
    });
    await mirror.afterItemVersionPersisted(eventFrom(item));
    await mirror.flush();
    // First write: lands in the main repo subtree.
    expect(existsSync(join(root, 'main', 'sales', 'concepts', `${item.slug}.md`))).toBe(true);

    // Bind the topic to a dedicated repo — same router instance, no restart.
    await repos.upsert(item.space_id!, { remote_url: bare }, adminId);
    const v2 = await items.update({ id: adminId, role: 'admin' }, item.id, item.version_token, { body: 'v2' });
    await mirror.afterItemVersionPersisted(eventFrom(v2));
    await mirror.flush();

    // The edit now routes to the dedicated repo and pushes to its remote.
    expect(existsSync(join(root, 'topics', 'sales', 'concepts', `${item.slug}.md`))).toBe(true);
    const pushed = execFileSync('git', ['-C', bare, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' });
    expect(pushed).toContain(`concepts/${item.slug}.md`);

    rmSync(bare, { recursive: true, force: true });
  });
});
