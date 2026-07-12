import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { ItemsService } from '../src/items/items.service.js';

function gitInitBare(dir: string): void {
  execFileSync('git', ['init', '--bare', dir]);
}
function tree(bareDir: string): string {
  return execFileSync('git', ['-C', bareDir, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' });
}

/**
 * Main-repo remote + "Sync now" backfill, exercised through the *wired* mirror
 * (GIT_MIRROR_ROOT set so the real RoutingRevisionMirror is active). Proves the
 * backfill pushes content that predates the remote being configured.
 */
describe('Main repo remote + sync-now backfill e2e', () => {
  let app: INestApplication;
  let cookie: string;
  let adminId: string;
  let items: ItemsService;
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'e3-main-sync-'));
    process.env['GIT_MIRROR_ROOT'] = root;
    app = await makeApp();
    ({ cookie, userId: adminId } = await seedAdminAndLogin(app));
    items = app.get(ItemsService);
  });

  afterEach(async () => {
    await app.close();
    delete process.env['GIT_MIRROR_ROOT'];
    rmSync(root, { recursive: true, force: true });
  });

  it('backfills a topic to the main remote after it is configured', async () => {
    const bare = join(root, 'main.git');
    gitInitBare(bare);

    // Content created BEFORE any remote exists (writes to the local main repo).
    const a = await items.create(adminId, { title: 'Runbook A', body: 'x', status: 'published', frontmatter: { topic: 'Ops' } });
    const b = await items.create(adminId, { title: 'Runbook B', body: 'y', status: 'published', frontmatter: { topic: 'Ops' } });
    expect(a.space_id).toBe(b.space_id);

    // Configure the instance main remote, then Sync now — both over HTTP (admin).
    await request(app.getHttpServer())
      .put('/api/v1/admin/repos/main')
      .set('Cookie', cookie)
      .send({ remote_url: bare })
      .expect(200);

    const sync = await request(app.getHttpServer())
      .post(`/api/v1/admin/repos/${a.space_id}/sync`)
      .set('Cookie', cookie)
      .expect(201);
    expect(sync.body.items).toBeGreaterThanOrEqual(2);

    // The pre-existing content is now on the remote, as topic subtrees.
    const pushed = tree(bare);
    expect(pushed).toContain(`ops/concepts/${a.slug}.md`);
    expect(pushed).toContain(`ops/concepts/${b.slug}.md`);
    expect(pushed).toContain('index.md');
  });
});
