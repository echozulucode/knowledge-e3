import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { buildBundle, type PageInput } from '@echozedlabs/okf';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { ItemsService, type ItemView } from '../src/items/items.service.js';
import { OkfImportService } from '../src/okf/okf-import.service.js';
import type { ReadActor } from '../src/pages/pages.service.js';

describe('OKF import service e2e', () => {
  let app: INestApplication;
  let items: ItemsService;
  let importer: OkfImportService;
  let actor: ReadActor;

  beforeEach(async () => {
    app = await makeApp();
    const login = await seedAdminAndLogin(app);
    actor = { id: login.userId, role: 'admin' };
    items = app.get(ItemsService);
    importer = app.get(OkfImportService);
  });

  afterEach(async () => app.close());

  function toPageInput(item: ItemView): PageInput {
    return {
      id: item.id,
      slug: item.slug,
      title: item.title,
      status: item.status,
      space: item.space_id,
      tags: item.tags,
      categories: item.categories,
      groups: item.groups,
      rawMarkdown: item.raw_markdown,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    };
  }

  async function exportAll(): Promise<{ files: { path: string; content: string }[] }> {
    const all = await items.list({ limit: 1000 }, actor);
    return buildBundle(all.map(toPageInput), { linkStyle: 'dual' });
  }

  it('re-importing an exported bundle updates items instead of duplicating them', async () => {
    const orders = await items.create(actor.id, {
      title: 'Round Trip Orders',
      body: 'Joined with [[Round Trip Customers]] on id.',
      status: 'published',
      tags: ['sales'],
    });
    await items.create(actor.id, {
      title: 'Round Trip Customers',
      body: 'Referenced by orders.',
      status: 'published',
      tags: ['sales'],
    });

    const before = await items.list({ limit: 1000 }, actor);
    expect(before).toHaveLength(2);

    const bundle = await exportAll();
    const result = await importer.importBundleFiles(actor, bundle.files);

    expect(result.created).toBe(0);
    expect(result.updated).toBe(2);

    const after = await items.list({ limit: 1000 }, actor);
    expect(after, 're-import must not create duplicates').toHaveLength(2);

    // The cross-reference survives the round-trip as an E3 wiki-link.
    const reloaded = await items.getById(orders.id, actor);
    expect(reloaded?.body_markdown).toContain('[[Round Trip Customers]]');
  });

  it('creates a new item when the concept has no matching id or title', async () => {
    await items.create(actor.id, {
      title: 'Existing Item',
      body: 'Body.',
      status: 'published',
    });

    const concept = [
      '---',
      'type: Knowledge Page',
      'title: Imported From Elsewhere',
      'tags:',
      '  - imported',
      'e3_id: itm_from_other_instance',
      'e3_status: published',
      'e3_categories:',
      '  - reference',
      '---',
      '',
      'Body created by an external producer.',
      '',
    ].join('\n');

    const result = await importer.importBundleFiles(actor, [
      { path: 'concepts/imported-from-elsewhere.md', content: concept },
      { path: 'index.md', content: '---\nokf_version: "0.1"\n---\n\n# Index\n' },
    ]);

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);

    const created = await items.getByTitle('Imported From Elsewhere', actor);
    expect(created).toBeTruthy();
    expect(created?.tags).toContain('imported');
    expect(created?.categories).toContain('reference');
    expect(created?.status).toBe('published');
  });
});
