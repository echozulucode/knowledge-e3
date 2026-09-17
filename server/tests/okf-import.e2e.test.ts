import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { buildBundle, type PageInput } from '@echozedlabs/okf';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { ItemsService, type ItemView } from '../src/items/items.service.js';
import { OkfExportService } from '../src/okf/okf-export.service.js';
import { OkfImportService } from '../src/okf/okf-import.service.js';
import type { ReadActor } from '../src/pages/pages.service.js';
import { SpacesService } from '../src/taxonomy/spaces.service.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Kysely } from 'kysely';
import type { Database } from '../src/db/schema.js';

describe('OKF import service e2e', () => {
  let app: INestApplication;
  let items: ItemsService;
  let importer: OkfImportService;
  let spaces: SpacesService;
  let db: Kysely<Database>;
  let actor: ReadActor;

  beforeEach(async () => {
    app = await makeApp();
    const login = await seedAdminAndLogin(app);
    actor = { id: login.userId, role: 'admin' };
    items = app.get(ItemsService);
    importer = app.get(OkfImportService);
    spaces = app.get(SpacesService);
    db = app.get(KYSELY);
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

  function concept(title: string, body: string, extra: string[] = []): string {
    return [
      '---',
      'type: Knowledge Page',
      `title: ${title}`,
      'e3_status: published',
      ...extra,
      '---',
      '',
      body,
      '',
    ].join('\n');
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
    expect(result.ids).toEqual(['itm_from_other_instance']);

    const created = await items.getById('itm_from_other_instance', actor);
    expect(created).toBeTruthy();
    expect(created?.tags).toContain('imported');
    expect(created?.categories).toContain('reference');
    expect(created?.status).toBe('published');

    const second = await importer.importBundleFiles(actor, [
      {
        path: 'concepts/imported-from-elsewhere.md',
        content: concept.replace(
          'Body created by an external producer.',
          'Body updated by the external producer.',
        ),
      },
    ]);

    expect(second).toMatchObject({
      created: 0,
      updated: 1,
      ids: ['itm_from_other_instance'],
    });
    expect((await items.getById('itm_from_other_instance', actor))?.body_markdown).toContain(
      'Body updated by the external producer.',
    );
    expect(await items.list({ limit: 1000 }, actor)).toHaveLength(2);
  });

  it('does not fall back to title when a supplied stable id is not present', async () => {
    const alpha = await spaces.create({ name: 'Alpha' });
    const existing = await items.create(actor.id, {
      title: 'External Identity',
      body: 'Existing original.',
      frontmatter: { topic: alpha.slug },
      status: 'published',
    });

    await expect(
      importer.importBundleFiles(
        actor,
        [
          {
            path: 'concepts/external-identity.md',
            content: concept('External Identity', 'Must not overwrite.', ['e3_id: itm_other_instance']),
          },
        ],
        { space: alpha.slug },
      ),
    ).rejects.toThrow('An item titled "External Identity" already exists in this topic');

    expect((await items.getById(existing.id, actor))?.body_markdown).toContain('Existing original.');
  });

  it('updates only the same-title item in the explicit destination topic', async () => {
    const alpha = await spaces.create({ name: 'Alpha' });
    const beta = await spaces.create({ name: 'Beta' });
    const alphaItem = await items.create(actor.id, {
      title: 'Shared Runbook',
      body: 'Alpha original.',
      frontmatter: { topic: alpha.slug },
      status: 'published',
    });
    const betaItem = await items.create(actor.id, {
      title: 'Shared Runbook',
      body: 'Beta original.',
      frontmatter: { topic: beta.slug },
      status: 'published',
    });

    const result = await importer.importBundleFiles(
      actor,
      [{ path: 'concepts/shared-runbook.md', content: concept('Shared Runbook', 'Alpha imported.') }],
      { space: alpha.slug },
    );

    expect(result).toMatchObject({ created: 0, updated: 1, ids: [alphaItem.id] });
    expect((await items.getById(alphaItem.id, actor))?.body_markdown).toContain('Alpha imported.');
    expect((await items.getById(betaItem.id, actor))?.body_markdown).toContain('Beta original.');
  });

  it('creates in the explicit destination instead of updating a same-title item elsewhere', async () => {
    const alpha = await spaces.create({ name: 'Alpha' });
    const beta = await spaces.create({ name: 'Beta' });
    const alphaItem = await items.create(actor.id, {
      title: 'Scoped Concept',
      body: 'Alpha original.',
      frontmatter: { topic: alpha.slug },
      status: 'published',
    });

    const result = await importer.importBundleFiles(
      actor,
      [{ path: 'concepts/scoped-concept.md', content: concept('Scoped Concept', 'Beta imported.') }],
      { space: beta.slug },
    );

    expect(result).toMatchObject({ created: 1, updated: 0 });
    expect((await items.getById(alphaItem.id, actor))?.body_markdown).toContain('Alpha original.');
    const betaItems = await items.list({ space: beta.slug }, actor);
    expect(betaItems).toHaveLength(1);
    expect(betaItems[0]?.id).toBe(result.ids[0]);
    expect(betaItems[0]?.body_markdown).toContain('Beta imported.');
  });

  it('fails before mutation when the explicit destination topic is unknown', async () => {
    await expect(
      importer.importBundleFiles(
        actor,
        [{ path: 'concepts/unknown.md', content: concept('Unknown Destination', 'Must not import.') }],
        { space: 'does-not-exist' },
      ),
    ).rejects.toThrow('destination topic "does-not-exist" not found');

    expect(await items.list({ limit: 1000 }, actor)).toHaveLength(0);
  });

  it('fails before mutation when a destination reference matches different topic slug and name', async () => {
    await spaces.create({ slug: 'alpha', name: 'First Topic' });
    await spaces.create({ slug: 'second', name: 'Alpha' });

    await expect(
      importer.importBundleFiles(
        actor,
        [{ path: 'concepts/ambiguous.md', content: concept('Ambiguous Destination', 'Must not import.') }],
        { space: 'Alpha' },
      ),
    ).rejects.toThrow('destination topic "Alpha" is ambiguous');

    expect(await items.list({ limit: 1000 }, actor)).toHaveLength(0);
  });

  it('fails before mutation when legacy data contains duplicate titles in the destination topic', async () => {
    const alpha = await spaces.create({ name: 'Alpha' });
    const first = await items.create(actor.id, {
      title: 'Duplicate Identity',
      body: 'First original.',
      frontmatter: { topic: alpha.slug },
      status: 'published',
    });
    const second = await items.create(actor.id, {
      title: 'Temporary Title',
      body: 'Second original.',
      frontmatter: { topic: alpha.slug },
      status: 'published',
    });
    // Simulate pre-existing corrupt/legacy data that bypassed PagesService's
    // application-level per-topic title uniqueness check.
    await db
      .updateTable('pages')
      .set({ title: 'Duplicate Identity' })
      .where('id', '=', second.id)
      .execute();

    await expect(
      importer.importBundleFiles(
        actor,
        [{ path: 'concepts/duplicate.md', content: concept('Duplicate Identity', 'Must not update.') }],
        { space: alpha.slug },
      ),
    ).rejects.toThrow('multiple items titled "Duplicate Identity" exist in the destination topic');

    expect((await items.getById(first.id, actor))?.body_markdown).toContain('First original.');
    expect((await items.getById(second.id, actor))?.body_markdown).toContain('Second original.');
  });

  it('preflights every file before mutation when item-level destinations vary', async () => {
    const alpha = await spaces.create({ name: 'Alpha' });

    await expect(
      importer.importBundleFiles(actor, [
        {
          path: 'concepts/valid-first.md',
          content: concept('Valid First', 'Must not be partially imported.', [`e3_space: ${alpha.slug}`]),
        },
        {
          path: 'concepts/invalid-second.md',
          content: concept('Invalid Second', 'Unknown destination.', ['e3_space: missing-topic']),
        },
      ]),
    ).rejects.toThrow('destination topic "missing-topic" not found');

    expect(await items.list({ limit: 1000 }, actor)).toHaveLength(0);
  });

  it('rejects duplicate Space-and-title identities in one bundle before mutation', async () => {
    const alpha = await spaces.create({ name: 'Alpha' });

    await expect(
      importer.importBundleFiles(
        actor,
        [
          { path: 'concepts/first.md', content: concept('Duplicate Bundle Item', 'First body.') },
          { path: 'concepts/second.md', content: concept('Duplicate Bundle Item', 'Second body.') },
        ],
        { space: alpha.slug },
      ),
    ).rejects.toThrow('duplicate import identity for "Duplicate Bundle Item"');

    expect(await items.list({ limit: 1000 }, actor)).toHaveLength(0);
  });
  it('round-trips the topic presentation through the bundle-root index.md', async () => {
    const alpha = await spaces.create({ name: 'Alpha', presentation: 'portal', landing_markdown: 'Gateway prose.', start_here: 'use-ai' });
    const beta = await spaces.create({ name: 'Beta' });
    await items.create(actor.id, { title: 'Use AI', body: 'Body.', frontmatter: { topic: alpha.slug }, status: 'published' });

    // A topic-scoped export writes the topic's profile into index.md (and nothing else carries it).
    const exported = await app.get(OkfExportService).export(actor, { space: alpha.slug });
    const index = exported.bundle.files.find((f) => f.path === 'index.md');
    expect(index?.content).toContain('presentation: portal');
    expect(index?.content).toContain('start_here: "use-ai"');
    expect(index?.content).toContain('Gateway prose.');
    expect(exported.conformance.conformant).toBe(true);

    // Importing into a named topic applies the profile to that topic; no topic is created.
    await importer.importBundleFiles(actor, exported.bundle.files, { space: beta.slug });
    const betaAfter = (await spaces.list()).find((s) => s.id === beta.id);
    expect(betaAfter).toMatchObject({ presentation: 'portal', landing_markdown: 'Gateway prose.', start_here: 'use-ai' });
    expect((await spaces.list()).map((s) => s.slug).sort()).toEqual(['alpha', 'beta', 'default']);

    // Without a destination topic the index is informational only.
    const unscoped = await spaces.create({ name: 'Gamma' });
    await importer.importBundleFiles(actor, [index!]);
    expect((await spaces.list()).find((s) => s.id === unscoped.id)).toMatchObject({ presentation: 'wiki', landing_markdown: null });
  });
});
