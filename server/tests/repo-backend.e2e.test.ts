import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { ItemsService, type ItemView } from '../src/items/items.service.js';
import { RepoConfigService } from '../src/storage/repo-config.service.js';
import { RoutingRevisionMirror } from '../src/storage/routing-revision-mirror.adapter.js';
import type { RevisionMirrorEvent } from '../src/storage/revision-mirror.port.js';

function gitInitBare(dir: string): void {
  execFileSync('git', ['init', '--bare', dir]);
}
function remoteBranchCount(bareDir: string): number {
  const out = execFileSync('git', ['-C', bareDir, 'for-each-ref', '--format=%(refname)', 'refs/heads'], {
    encoding: 'utf8',
  }).trim();
  return out ? out.split('\n').length : 0;
}

describe('Backend repo mapping + push e2e', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let items: ItemsService;
  let repos: RepoConfigService;
  let adminId: string;
  let tmp: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ userId: adminId } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
    items = app.get(ItemsService);
    repos = app.get(RepoConfigService);
    tmp = mkdtempSync(join(tmpdir(), 'e3-repo-backend-'));
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
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

  it('binds a dedicated repo at topic creation', async () => {
    const { cookie } = await seedAdminAndLogin(app, 'creator', 'creator-password-123');
    const created = await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', cookie)
      .send({ name: 'Research', repo: { remote_url: 'git@example.com:org/research.git', branch: 'main' } })
      .expect(201);

    const spaceId = created.body.topic.id;
    const mappings = await repos.list();
    const mapping = mappings.find((m) => m.space_id === spaceId);
    expect(mapping?.remote_url).toBe('git@example.com:org/research.git');
    expect(mapping?.branch).toBe('main');
  });

  it('checks connectivity against a reachable remote and rejects a bogus one', async () => {
    const bare = join(tmp, 'remote.git');
    gitInitBare(bare);

    const ok = await repos.testConnection(bare);
    expect(ok.ok).toBe(true);

    const bad = await repos.testConnection(join(tmp, 'does-not-exist.git'));
    expect(bad.ok).toBe(false);
  });

  it('persists a per-topic mapping and pushes that topic to its backend repo', async () => {
    const bare = join(tmp, 'physics.git');
    gitInitBare(bare);

    // An item in a topic, and a mapping of that topic to the backend repo.
    const item = await items.create(adminId, {
      title: 'Quark',
      body: 'A physics note.',
      status: 'published',
      frontmatter: { topic: 'Physics' },
    });
    expect(item.space_id).toBeTruthy();
    await repos.upsert(item.space_id!, { remote_url: bare }, adminId);

    const mappings = await repos.list();
    expect(mappings.find((m) => m.space_id === item.space_id)?.remote_url).toBe(bare);

    // Mirror routes the topic to its own repo and pushes to the backend.
    const root = join(tmp, 'wiki-repos');
    const mirror = new RoutingRevisionMirror(root, db, { quietMs: 20, maxMs: 50 });
    await mirror.afterItemVersionPersisted(eventFrom(item));
    await mirror.flush();

    // The backend bare repo received the pushed branch with the content.
    expect(remoteBranchCount(bare)).toBeGreaterThanOrEqual(1);
    const tree = execFileSync('git', ['-C', bare, 'ls-tree', '-r', '--name-only', 'HEAD'], {
      encoding: 'utf8',
    });
    expect(tree).toContain(`concepts/${item.slug}.md`);
    expect(tree).toContain('index.md');
  });
});
