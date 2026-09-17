/**
 * ContentCommands seam (plan §5.1, §9.3, Phase 1): one write path, lint in
 * warn mode for drafts (diagnostics returned, never blocking; publishing is
 * gated — see publish-lint-gate.e2e.test.ts), OKF `verified[]` stamping,
 * and the existing optimistic-concurrency semantics preserved end to end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ConflictException, UnprocessableEntityException, type INestApplication } from '@nestjs/common';
import { conformant, makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { ContentCommandsService } from '../src/content/content-commands.service.js';
import { actorFrom, type ServerActor } from '../src/content/actor.js';
import { KnowledgeQueryService } from '../src/query/knowledge-query.service.js';

describe('ContentCommands seam', () => {
  let app: INestApplication;
  let cookie: string;
  let actor: ServerActor;
  let commands: ContentCommandsService;
  let query: KnowledgeQueryService;

  beforeEach(async () => {
    app = await makeApp();
    const login = await seedAdminAndLogin(app);
    cookie = login.cookie;
    actor = actorFrom({ id: login.userId, username: 'admin', role: 'admin' }, 'rest');
    commands = app.get(ContentCommandsService);
    query = app.get(KnowledgeQueryService);
    // `guides` is CURATED here, not conjured by the first document that uses it.
    // Primary categories are curated, not emergent (Eric, 2026-09-11 — issues
    // 97/106): the publish gate lints against the `primary_categories` catalog,
    // so a document naming a term no admin registered is refused.
    await request(app.getHttpServer())
      .post('/api/v1/taxonomy/categories')
      .set('Cookie', cookie)
      .send({ slug: 'guides', name: 'Guides' })
      .expect(201);
  });
  afterEach(async () => app.close());

  it('maps the authenticated user to an OKF human actor', () => {
    expect(actor).toEqual({ userId: actor.userId, okfActor: 'human:admin', via: { kind: 'rest' }, role: 'admin' });
    expect(actorFrom({ id: 'local-system', username: 'local-system' }, 'mcp')).toMatchObject({ okfActor: 'process:knowledge-e3', role: 'user' });
  });

  it('creates a draft and returns lint diagnostics without blocking', async () => {
    const result = await commands.create(actor, { raw: '---\ntitle: No Category\ntype: Concept\n---\nBody.\n' }, 'rest');

    expect(result.item).toMatchObject({ title: 'No Category', status: 'draft', type: 'Concept', version_token: 1 });
    expect(result.diagnostics.map((d) => d.code)).toContain('category.missing');
    expect(result.diagnostics.find((d) => d.code === 'category.missing')).toMatchObject({ severity: 'error', path: 'categories' });

    const got = await request(app.getHttpServer()).get(`/api/v1/items/${result.item.id}`).set('Cookie', cookie).expect(200);
    expect(got.body.item.id).toBe(result.item.id);

    const clean = await commands.create(actor, { raw: '---\ntitle: Categorized\ntype: Concept\ncategories: [guides]\nstale_after: 2999-01-01\n---\nBody.\n' }, 'rest');
    expect(clean.diagnostics.map((d) => d.code)).not.toContain('category.missing');

    // Warn mode is for drafts. The same non-conformant document created
    // published in one call is a publication, and is refused (issue 98).
    await expect(
      commands.create(actor, { raw: '---\ntitle: Born Published\ntype: Concept\n---\nBody.\n', status: 'published' }, 'rest'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('serves the ui door through the /pages contract (published_at present, same view as today)', async () => {
    const result = await commands.create(actor, { title: 'UI Page', body: 'Hello', status: 'published', frontmatter: conformant({ categories: ['guides'] }) }, 'ui');
    expect(result.item).toMatchObject({ title: 'UI Page', status: 'published' });
    expect(result.item.published_at).toEqual(expect.any(String));
  });

  it('publish with reviewed=true publishes and appends a human verification', async () => {
    // Publishing is gated on the content-model rules, so the documents in this
    // test carry a `description` and the curated primary category registered in
    // `beforeEach`.
    const created = await commands.create(
      actor,
      { raw: '---\ntitle: To Review\ntype: Concept\ndescription: A document to review.\ncategories: [guides]\n---\nBody.\n' },
      'rest',
    );
    expect(created.item.status).toBe('draft');

    const published = await commands.publish(actor, created.item.id, { reviewed: true });
    expect(published.item.status).toBe('published');
    expect(published.item.version_token).toBe(2);
    expect(published.item.frontmatter['verified']).toEqual([{ by: 'human:admin', at: expect.any(String) }]);

    const view = await query.item(created.item.id, { userId: actor.userId, role: 'admin' });
    expect(view).toMatchObject({ display_state: 'published', trust_tier: 'human-reviewed' });
    expect(view!.last_verified_at).toEqual(expect.any(String));

    // Without `reviewed`, publish is a status change only.
    const other = await commands.create(
      actor,
      { raw: '---\ntitle: Plain Publish\ntype: Concept\ndescription: A plain publish.\ncategories: [guides]\n---\nBody.\n' },
      'rest',
    );
    const plain = await commands.publish(actor, other.item.id);
    expect(plain.item.status).toBe('published');
    expect(plain.item.frontmatter['verified']).toBeUndefined();
  });

  it('verify appends to verified[] without changing publication status', async () => {
    const created = await commands.create(actor, { raw: '---\ntitle: Verify Me\ntype: Concept\nverified:\n  by: reference_agent/1.0\n  at: 2026-01-01T00:00:00.000Z\n---\nBody.\n' }, 'rest');
    expect(created.item.status).toBe('draft');

    const verified = await commands.verify(actor, created.item.id);
    expect(verified.item.status).toBe('draft');
    expect(verified.item.frontmatter['verified']).toEqual([
      { by: 'reference_agent/1.0', at: '2026-01-01T00:00:00.000Z' },
      { by: 'human:admin', at: expect.any(String) },
    ]);
    expect(await query.item(created.item.id, { userId: actor.userId, role: 'admin' })).toMatchObject({ display_state: 'draft', trust_tier: 'human-reviewed' });
  });

  it('update keeps If-Match / version semantics (409 on mismatch, through the controller too)', async () => {
    const created = await commands.create(actor, { title: 'Versioned', body: 'v1' }, 'rest');
    const id = created.item.id;

    await expect(commands.update(actor, id, { body: 'stale write' }, 999, 'rest')).rejects.toBeInstanceOf(ConflictException);

    const conflict = await request(app.getHttpServer())
      .put(`/api/v1/items/${id}`)
      .set('Cookie', cookie)
      .set('If-Match', '999')
      .send({ body: 'stale write' })
      .expect(409);
    expect(conflict.body.current_version_token).toBe(1);

    const ok = await commands.update(actor, id, { body: 'v2' }, 1, 'rest');
    expect(ok.item.version_token).toBe(2);
    expect(ok.item.body_markdown).toContain('v2');
    expect(Array.isArray(ok.diagnostics)).toBe(true);
  });

  it('enforces owner-or-admin on mutations via the actor role', async () => {
    const alice = await seedUserAndLogin(app);
    const aliceActor = actorFrom({ id: alice.userId, username: 'alice', role: 'user' }, 'ui');
    const created = await commands.create(actor, { title: 'Admin Owned', body: 'x' }, 'ui');

    await expect(commands.update(aliceActor, created.item.id, { body: 'nope' }, 1, 'ui')).rejects.toThrow(/owner or an admin/);
    await expect(commands.remove(aliceActor, created.item.id)).rejects.toThrow(/owner or an admin/);
  });

  it('rename, remove, and restore delegate and report affected pages', async () => {
    const target = await commands.create(actor, { title: 'Rename Target', body: 'target', status: 'published', frontmatter: conformant({ categories: ['guides'] }) }, 'ui');
    const source = await commands.create(actor, { title: 'Rename Source', body: 'links to [[Rename Target]]', status: 'published', frontmatter: conformant({ categories: ['guides'] }) }, 'ui');

    const renamed = await commands.rename(actor, target.item.id, 'Renamed Target');
    expect(renamed.item.title).toBe('Renamed Target');
    // The renamed page itself is listed first, then every inbound linker.
    expect(renamed.affected_pages.map((p) => p.id)).toEqual([target.item.id, source.item.id]);

    await commands.remove(actor, target.item.id);
    await request(app.getHttpServer()).get(`/api/v1/items/${target.item.id}`).set('Cookie', cookie).expect(200).expect({ item: null });

    const restored = await commands.restore(actor, target.item.id);
    expect(restored.item.id).toBe(target.item.id);
  });

  it('lint alone fills in the live vocabularies', async () => {
    await commands.create(actor, { raw: '---\ntitle: Known Tagged\ntags: [known-tag]\ncategories: [guides]\n---\nx\n' }, 'rest');
    const diagnostics = await commands.lint('---\ntitle: Probe\ntype: Concept\ntags: [known-tag, brand-new]\ncategories: [guides]\n---\nSee [[Known Tagged]] and [[Missing Page]].\n', {});
    const codes = diagnostics.map((d) => `${d.code}:${d.message}`);
    expect(codes.some((c) => c.startsWith('tag.unknown:') && c.includes('brand-new'))).toBe(true);
    expect(codes.some((c) => c.startsWith('tag.unknown:') && c.includes('known-tag'))).toBe(false);
    expect(codes.some((c) => c.startsWith('link.unresolved:') && c.includes('Missing Page'))).toBe(true);
    expect(codes.some((c) => c.startsWith('link.unresolved:') && c.includes('Known Tagged'))).toBe(false);
  });
});
