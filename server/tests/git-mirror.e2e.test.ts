import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateBundle } from '@echozedlabs/okf';
import { Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { ItemsService, type ItemView } from '../src/items/items.service.js';
import { GitRevisionMirrorAdapter } from '../src/storage/git-revision-mirror.adapter.js';
import type { RevisionMirrorEvent } from '../src/storage/revision-mirror.port.js';

function gitRevCount(dir: string): number {
  return Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim());
}

/** Read every .md file in the bundle (skipping .git) as {path, content}. */
function readBundleFiles(root: string, sub = ''): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const entry of readdirSync(join(root, sub), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const rel = sub ? `${sub}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...readBundleFiles(root, rel));
    else if (entry.name.endsWith('.md')) out.push({ path: rel, content: readFileSync(join(root, rel), 'utf8') });
  }
  return out;
}

describe('GitRevisionMirrorAdapter (Phase A) e2e', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let items: ItemsService;
  let adminId: string;
  let dir: string;
  let adapter: GitRevisionMirrorAdapter;

  beforeEach(async () => {
    app = await makeApp();
    ({ userId: adminId } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
    items = app.get(ItemsService);
    dir = mkdtempSync(join(tmpdir(), 'e3-git-mirror-'));
    adapter = new GitRevisionMirrorAdapter(dir, db, { quietMs: 20, maxMs: 50 });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function eventFrom(item: ItemView, over: Partial<RevisionMirrorEvent> = {}): RevisionMirrorEvent {
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
      ...over,
    };
  }

  it('writes an OKF concept file immediately and commits it on flush', async () => {
    const orders = await items.create(adminId, {
      title: 'Orders',
      body: 'Joined with [[Customers]].',
      status: 'published',
      tags: ['sales'],
    });
    await adapter.afterItemVersionPersisted(eventFrom(orders));

    // File is written synchronously, before any commit.
    const conceptPath = join(dir, 'concepts', `${orders.slug}.md`);
    expect(existsSync(conceptPath)).toBe(true);
    const content = readFileSync(conceptPath, 'utf8');
    expect(content).toMatch(/^---\ntype: /);
    expect(content).toContain(`e3_id: ${orders.id}`);
    expect(content).toContain('[[Customers]]'); // preserve style keeps wiki-links

    await adapter.flush();
    expect(gitRevCount(dir)).toBe(1);

    const state = await db
      .selectFrom('revision_mirror_state')
      .selectAll()
      .where('page_id', '=', orders.id)
      .executeTakeFirst();
    expect(state?.backend).toBe('git');
    expect(state?.dirty).toBe(0);
    expect(state?.last_synced_version_token).toBe(orders.version_token);
    expect(state?.last_commit).toBeTruthy();
  });

  it('coalesces a burst of writes into a single commit', async () => {
    const alpha = await items.create(adminId, { title: 'Alpha', body: 'a', status: 'published' });
    const beta = await items.create(adminId, { title: 'Beta', body: 'b', status: 'published' });
    const gamma = await items.create(adminId, { title: 'Gamma', body: 'c', status: 'published' });

    await adapter.afterItemVersionPersisted(eventFrom(alpha));
    await adapter.afterItemVersionPersisted(eventFrom(beta));
    await adapter.afterItemVersionPersisted(eventFrom(gamma));
    await adapter.flush();

    expect(gitRevCount(dir)).toBe(1);
    const files = execFileSync('git', ['show', '--stat', '--name-only', '--pretty=format:', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
    });
    for (const item of [alpha, beta, gamma]) {
      expect(files).toContain(`concepts/${item.slug}.md`);
    }

    const rows = await db.selectFrom('revision_mirror_state').selectAll().execute();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.dirty === 0 && r.last_commit)).toBe(true);
  });

  it('makes a second commit for a later edit of the same item', async () => {
    const orders = await items.create(adminId, {
      title: 'Orders',
      body: 'Original body.',
      status: 'published',
    });
    await adapter.afterItemVersionPersisted(eventFrom(orders));
    await adapter.flush();

    const updated = await items.update({ id: adminId, role: 'admin' }, orders.id, orders.version_token, {
      body: 'Updated body.',
    });
    await adapter.afterItemVersionPersisted(eventFrom(updated));
    await adapter.flush();

    expect(gitRevCount(dir)).toBe(2);
    const content = readFileSync(join(dir, 'concepts', `${orders.slug}.md`), 'utf8');
    expect(content).toContain('Updated body.');

    const state = await db
      .selectFrom('revision_mirror_state')
      .selectAll()
      .where('page_id', '=', orders.id)
      .executeTakeFirst();
    expect(state?.last_synced_version_token).toBe(updated.version_token);
  });

  it('keeps the repo a conformant OKF bundle (root index.md + okf_version)', async () => {
    const a = await items.create(adminId, {
      title: 'Apples',
      body: 'Crisp.',
      status: 'published',
      tags: ['fruit'],
    });
    const b = await items.create(adminId, { title: 'Bananas', body: 'Yellow.', status: 'published' });
    await adapter.afterItemVersionPersisted(eventFrom(a));
    await adapter.afterItemVersionPersisted(eventFrom(b));
    await adapter.flush();

    // The bundle root manifest exists and declares the OKF version.
    const indexPath = join(dir, 'index.md');
    expect(existsSync(indexPath)).toBe(true);
    const index = readFileSync(indexPath, 'utf8');
    expect(index).toMatch(/okf_version: "0\.1"/);
    expect(index).toContain('(/concepts/apples.md)');
    expect(index).toContain('(/concepts/bananas.md)');

    // The whole working tree validates as a conformant OKF bundle.
    const files = readBundleFiles(dir);
    const report = validateBundle({ files });
    expect(report.conformant).toBe(true);
    expect(report.conceptCount).toBe(2);
  });

  it('flush is a no-op when there is nothing pending', async () => {
    await adapter.flush();
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });
});
