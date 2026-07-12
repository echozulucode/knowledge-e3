import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { ItemsService } from '../src/items/items.service.js';
import { SpacesService } from '../src/taxonomy/spaces.service.js';
import { RepoConfigService } from '../src/storage/repo-config.service.js';
import { RepoPullService } from '../src/storage/repo-pull.service.js';

/** Build a source git repo holding an OKF bundle, usable as a clone remote. */
function seedSourceRepo(dir: string, concepts: { slug: string; type: string; title: string }[]): void {
  mkdirSync(join(dir, 'concepts'), { recursive: true });
  for (const c of concepts) {
    writeFileSync(
      join(dir, 'concepts', `${c.slug}.md`),
      `---\ntype: ${c.type}\ntitle: ${c.title}\n---\n\n# ${c.title}\n\nBody for ${c.title}.\n`,
      'utf8',
    );
  }
  execFileSync('git', ['-C', dir, 'init']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'src@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Source']);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-m', 'seed']);
}

describe('Repo → topic pull e2e', () => {
  let app: INestApplication;
  let items: ItemsService;
  let spaces: SpacesService;
  let repos: RepoConfigService;
  let pull: RepoPullService;
  let adminId: string;
  let tmp: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ userId: adminId } = await seedAdminAndLogin(app));
    items = app.get(ItemsService);
    spaces = app.get(SpacesService);
    repos = app.get(RepoConfigService);
    pull = app.get(RepoPullService);
    tmp = mkdtempSync(join(tmpdir(), 'e3-pull-src-'));
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("clones a topic's bound repo and imports its concepts into that topic", async () => {
    const source = join(tmp, 'gamedev.git');
    seedSourceRepo(source, [
      { slug: 'quest-system', type: 'doc', title: 'Quest System' },
      { slug: 'save-format', type: 'doc', title: 'Save Format' },
    ]);

    const topic = await spaces.create({ name: 'Game Development' });
    await repos.upsert(topic.id, { remote_url: source }, adminId);

    const result = await pull.pullIntoTopic(topic.id, { id: adminId, role: 'admin' });
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);

    // Both concepts now exist as items, filed under the bound topic (not default).
    const quest = await items.getByTitle('Quest System');
    expect(quest).toBeTruthy();
    expect(quest!.space_id).toBe(topic.id);
    expect(quest!.body_markdown).toContain('Body for Quest System.');

    // Re-pull updates rather than duplicates.
    const again = await pull.pullIntoTopic(topic.id, { id: adminId, role: 'admin' });
    expect(again.created).toBe(0);
    expect(again.updated).toBe(2);
    const all = await items.list({ space: topic.id });
    expect(all).toHaveLength(2);
  });

  it('rejects a pull when no repo is bound to the topic', async () => {
    const topic = await spaces.create({ name: 'Unbound' });
    await expect(pull.pullIntoTopic(topic.id, { id: adminId, role: 'admin' })).rejects.toThrow(/No dedicated repository/);
  });
});
