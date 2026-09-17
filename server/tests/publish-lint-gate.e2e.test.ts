/**
 * The publish gate (Eric's decision, 2026-09-11; narrows plan §12 decision 6).
 *
 * Error-severity content-model diagnostics refuse **publication** — a draft
 * this actor takes to `published`, or a create that lands published in one call
 * (issue 98) — from the interactive doors (`ui`/`rest`/`mcp`), with
 * `422 lint_failed` carrying the diagnostics, and every refusal is audited as
 * `content.refused` (plan B2). Everything else stays warn-only: an ordinary save
 * (including of an already-published item), a draft create, and the inbound
 * doors (`git`/`import`).
 *
 * The measured reason for that narrowness is in these tests: content that
 * predates the content model carries no `type` and no `description`, so gating
 * ordinary saves would make it read-only. (The SEEDED corpus was migrated on
 * 2026-09-11 — `server/src/seed.ts` and `server/scripts/populate-demo-corpus.ts`
 * now write both — but an instance's real, already-imported content was not,
 * and cannot be.)
 *
 * Primary categories are CURATED, not emergent (Eric, 2026-09-11; issues 97 and
 * 106): the publishable vocabulary is the `primary_categories` catalog alone,
 * so `category.unknown` finally refuses something. See the inverted test below.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { digestOf } from '@echozedlabs/content-store';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { ContentCommandsService } from '../src/content/content-commands.service.js';
import { actorFrom, type ServerActor } from '../src/content/actor.js';
import { PagesService } from '../src/pages/pages.service.js';

/** A draft that fails the publish-time rules: no primary category, no description. */
const NON_CONFORMANT = '---\ntitle: Legacy Note\ntype: Concept\nstale_after: 2999-01-01\n---\nBody.\n';

/** The same document with everything the publish-time rules ask for. */
const CONFORMANT =
  '---\ntitle: Good Note\ntype: Concept\ndescription: Everything the lint asks for.\ncategories: [guides]\nstale_after: 2999-01-01\n---\nBody.\n';

describe('publish gate: error-severity lint refuses the draft→published transition', () => {
  let app: INestApplication;
  let cookie: string;
  let actor: ServerActor;
  let commands: ContentCommandsService;
  let pages: PagesService;
  let db: Kysely<Database>;

  beforeEach(async () => {
    app = await makeApp();
    const login = await seedAdminAndLogin(app);
    cookie = login.cookie;
    actor = actorFrom({ id: login.userId, username: 'admin', role: 'admin' }, 'rest');
    commands = app.get(ContentCommandsService);
    pages = app.get(PagesService);
    db = app.get<Kysely<Database>>(KYSELY);
    // `guides` has to be known vocabulary before a document may publish into it:
    // `lintContext` reads the vocabularies as they stood BEFORE the write.
    await request(app.getHttpServer())
      .post('/api/v1/taxonomy/categories')
      .set('Cookie', cookie)
      .send({ slug: 'guides', name: 'Guides' })
      .expect(201);
  });
  afterEach(async () => app.close());

  async function draft(raw = NON_CONFORMANT) {
    const created = await commands.create(actor, { raw }, 'rest');
    expect(created.item.status).toBe('draft');
    return created.item;
  }

  async function callTool(name: string, args: Record<string, unknown>) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/mcp/jsonrpc')
      .set('Cookie', cookie)
      .send({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } })
      .expect(200);
    return res.body;
  }

  // --- the refusal, on each interactive door --------------------------------

  it('ui door: PUT /pages refuses the publish and names every error to fix', async () => {
    const item = await draft();

    const res = await request(app.getHttpServer())
      .put(`/api/v1/pages/${item.id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(item.version_token))
      .send({ status: 'published', frontmatter: { ...item.frontmatter, status: 'published' } })
      .expect(422);

    expect(res.body.reason).toBe('lint_failed');
    expect(res.body.diagnostics.map((d: { code: string }) => d.code).sort()).toEqual([
      'category.missing',
      'description.missing',
    ]);
    // Every diagnostic points at the frontmatter key Compose has to fix.
    expect(res.body.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'error', path: expect.any(String) })]),
    );

    // Nothing was written: the refusal runs before the file and the index.
    const after = await pages.getById(item.id);
    expect(after).toMatchObject({ status: 'draft', version_token: item.version_token });
  });

  it('REFUSES a publish whose primary category is not in the curated catalog', async () => {
    // The inversion of a test that used to pin the opposite, and the proof that
    // the decision took effect. PRIMARY CATEGORIES ARE CURATED, NOT EMERGENT
    // (Eric, 2026-09-11; settles issues 97 and 106).
    //
    // What this test asserted before that date: an invented category published
    // happily. `category.unknown` is error-severity, so it looked like the gate
    // should refuse it — and it could not, because `lintContext` read
    // `SpacesService.listCategories`, which unions the admin-curated
    // `primary_categories` catalog with USAGE rows from `page_categories`. The
    // act of saving the draft registered its own category, so by the time the
    // same item was published the rule had nothing left to fire on: unreachable
    // on the interactive path by construction.
    //
    // `lintContext` now reads `listCuratedCategories` — the catalog alone —
    // while `listCategories` keeps the union for browse, the facets, and the
    // taxonomy admin, which must still show a stray term that legacy content
    // uses. Two accessors, deliberately: "what may I publish into" is not "what
    // exists". Re-merging them silently un-does this test.
    const item = await draft(
      '---\ntitle: Invented Category\ntype: Concept\ndescription: Has everything but a real category.\ncategories: [not-a-real-category]\n---\nBody.\n',
    );

    const res = await request(app.getHttpServer())
      .put(`/api/v1/pages/${item.id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(item.version_token))
      .send({ status: 'published', frontmatter: { ...item.frontmatter, status: 'published' } })
      .expect(422);

    expect(res.body.reason).toBe('lint_failed');
    expect(res.body.diagnostics.map((d: { code: string }) => d.code)).toEqual(['category.unknown']);
    // It points at the frontmatter key, which is the Publish drawer's category
    // picker — the author fixes it by choosing, never by inventing.
    expect(res.body.diagnostics[0]).toMatchObject({ severity: 'error', path: 'categories' });

    // Nothing was written, and the stray term never entered the vocabulary.
    expect(await pages.getById(item.id)).toMatchObject({ status: 'draft', version_token: item.version_token });
  });

  it('accepts the curated category by slug or by its display name', async () => {
    // `lintContext` feeds the lint both forms for every catalog row, because a
    // document may name its category either way: the Publish drawer writes the
    // slug (`guides`), while hand-written and imported frontmatter often carries
    // the human label (`Guides`). That leniency is the whole of it — an invented
    // term is still unknown (the test above).
    const byName = await draft(
      '---\ntitle: Category By Name\ntype: Concept\ndescription: Names its category the way a human writes it.\ncategories: [Guides]\n---\nBody.\n',
    );
    const result = await commands.publish(actor, byName.id);
    expect(result.item.status).toBe('published');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('refuses a publish into an ARCHIVED category — archiving retires the term for new writes', async () => {
    // Archiving is how an admin retires a primary category. The catalog accessor
    // excludes archived rows, so an item may no longer be published into one;
    // items already filed under it keep it (that is `listCategories`' job).
    await request(app.getHttpServer())
      .post('/api/v1/taxonomy/categories')
      .set('Cookie', cookie)
      .send({ slug: 'retired', name: 'Retired' })
      .expect(201);
    const item = await draft(
      '---\ntitle: Retired Category\ntype: Concept\ndescription: Files itself under a retired term.\ncategories: [retired]\n---\nBody.\n',
    );
    await request(app.getHttpServer()).delete('/api/v1/taxonomy/categories/retired').set('Cookie', cookie).expect(200);

    const res = await request(app.getHttpServer())
      .put(`/api/v1/pages/${item.id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(item.version_token))
      .send({ status: 'published', frontmatter: { ...item.frontmatter, status: 'published' } })
      .expect(422);
    expect(res.body.diagnostics.map((d: { code: string }) => d.code)).toContain('category.unknown');
  });

  it('rest door: PUT /items refuses the publish', async () => {
    const item = await draft();
    const res = await request(app.getHttpServer())
      .put(`/api/v1/items/${item.id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(item.version_token))
      .send({ status: 'published' })
      .expect(422);
    expect(res.body.reason).toBe('lint_failed');
    expect((await pages.getById(item.id))!.status).toBe('draft');
  });

  it('mcp door: publish_item and a status-flipping update_item are both refused, with the diagnostics in error.data', async () => {
    const item = await draft();

    const published = await callTool('knowledge.publish_item', { id: item.id });
    expect(published.error.data.reason).toBe('lint_failed');
    expect(published.error.data.diagnostics.map((d: { code: string }) => d.code)).toContain('description.missing');

    const updated = await callTool('knowledge.update_item', {
      id: item.id,
      version_token: item.version_token,
      status: 'published',
    });
    expect(updated.error.data.reason).toBe('lint_failed');
    expect((await pages.getById(item.id))!.status).toBe('draft');
  });

  it('lets a conformant draft publish through every door', async () => {
    const good = await draft(CONFORMANT);
    const result = await commands.publish(actor, good.id);
    expect(result.item.status).toBe('published');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  // --- what the gate must NOT touch ----------------------------------------

  it('does not refuse an autosave of an ALREADY-published item that fails the lint', async () => {
    // The trap: the gate tests the draft→published TRANSITION, not the state.
    // Much of the existing corpus is published and non-conformant; refusing its
    // saves would make the library read-only, which is worse than warn mode.
    const legacy = await pages.create(actor.userId, {
      title: 'Legacy Published',
      body: 'x',
      status: 'published',
      frontmatter: { title: 'Legacy Published', status: 'published' },
    });
    expect(legacy.status).toBe('published');

    const saved = await commands.update(
      actor,
      legacy.id,
      { body: 'Autosaved while still non-conformant.' },
      legacy.version_token,
      'ui',
    );
    expect(saved.item.status).toBe('published');
    expect(saved.item.version_token).toBe(legacy.version_token + 1);
    // The diagnostics still come back — warn mode is what they are for.
    expect(saved.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(['type.missing', 'description.missing']));

    // And again, so it is the transition that is absent, not a one-shot pass.
    const again = await commands.update(actor, legacy.id, { body: 'Once more.' }, saved.item.version_token, 'ui');
    expect(again.item.version_token).toBe(legacy.version_token + 2);
  });

  it('does not apply the publish-time rules to a plain draft save', async () => {
    // `description.missing` and the Blog Post rules are publish-time; a draft
    // save must never be refused for them.
    const item = await draft();
    const saved = await commands.update(actor, item.id, { body: 'Still a draft.' }, item.version_token, 'ui');
    expect(saved.item.status).toBe('draft');
    expect(saved.item.version_token).toBe(item.version_token + 1);
    // The publish-time rules are not even evaluated for a draft, so the save is
    // neither refused nor warned about `description`.
    expect(saved.diagnostics.map((d) => d.code)).not.toContain('description.missing');
    expect(saved.diagnostics.map((d) => d.code)).toContain('category.missing');
  });

  /** Every `content.refused` row, payload parsed, oldest first. */
  async function refusals() {
    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'content.refused')
      .orderBy('id', 'asc')
      .execute();
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload_json!) as Record<string, unknown> }));
  }

  it('REFUSES a REST create that lands published in one call, with the structured 422 MCP gets (issue 98)', async () => {
    // Pinned the opposite until the suites that built fixtures by creating
    // non-conformant published items over REST were made conformant. Creating
    // an item already published never passes through the draft→published
    // transition, so without this the gate was advisory for every REST client.
    const raw = NON_CONFORMANT.replace('Legacy Note', 'Born Published').replace('Body.', 'SECRET-BODY-MARKER');
    const res = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ raw, status: 'published' })
      .expect(422);

    expect(res.body.reason).toBe('lint_failed');
    expect(res.body.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'description.missing', severity: 'error', path: 'description', message: expect.any(String) }),
        expect.objectContaining({ code: 'category.missing', severity: 'error', path: 'categories' }),
      ]),
    );
    // Nothing was written: the gate runs before the file and the index.
    expect(await pages.getByTitle('Born Published')).toBeNull();

    // And the refusal is on the record, for the administrator who never saw the 422.
    const rows = await refusals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: actor.userId, page_id: null });
    expect(rows[0]!.payload).toEqual({
      reason: 'lint_failed',
      source: 'rest',
      operation: 'create',
      title: 'Born Published',
      slug: null,
      topic: null,
      rules: expect.arrayContaining([
        { code: 'description.missing', path: 'description' },
        { code: 'category.missing', path: 'categories' },
      ]),
    });
    // Rule ids and fields only: never the document, and never a diagnostic
    // message (which can quote the document back).
    expect(rows[0]!.payload_json).not.toContain('SECRET-BODY-MARKER');
    expect(rows[0]!.payload_json).not.toContain('is required');
  });

  it('ui door: a Compose create that lands published is refused and audited as `ui`', async () => {
    // Compose publishes a never-saved item by POSTing `/pages` with
    // `status: published`; `validateForPublish` refuses it client-side first,
    // and this is the backstop for any client that does not.
    const res = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title: 'Compose Born Published', body: 'Body.', status: 'published', frontmatter: { type: 'Concept' } })
      .expect(422);
    expect(res.body.reason).toBe('lint_failed');
    expect(await pages.getByTitle('Compose Born Published')).toBeNull();
    expect((await refusals()).map((r) => r.payload)).toEqual([
      expect.objectContaining({ source: 'ui', operation: 'create', title: 'Compose Born Published' }),
    ]);
  });

  it('lets a conformant REST create land published in one call, and audits nothing', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ raw: CONFORMANT.replace('Good Note', 'REST Conformant'), status: 'published' })
      .expect(201);
    expect(res.body.item.status).toBe('published');
    expect(await refusals()).toEqual([]);
  });

  it('audits a refused publish of an existing draft with its item, slug and topic', async () => {
    const item = await draft();
    await request(app.getHttpServer())
      .put(`/api/v1/items/${item.id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(item.version_token))
      .send({ status: 'published' })
      .expect(422);

    const rows = await refusals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: actor.userId, page_id: item.id });
    expect(rows[0]!.payload).toMatchObject({
      reason: 'lint_failed',
      source: 'rest',
      operation: 'publish',
      title: 'Legacy Note',
      slug: item.slug,
      topic: expect.any(String),
    });
  });

  it('DOES refuse an MCP create that lands published in one call — otherwise the gate is advisory for agents', async () => {
    // The bypass this closes: creating an item already published never passes
    // through the draft→published transition the gate watches, so an agent
    // could publish anything by creating it published. Every interactive door
    // is held to this now (issue 98); MCP was simply the first.
    const body = await callTool('knowledge.create_item', {
      raw_markdown: NON_CONFORMANT.replace('Legacy Note', 'Agent Born Published'),
      status: 'published',
    });
    expect(body.error).toBeTruthy();
    expect(body.error.data).toMatchObject({ reason: 'lint_failed' });
    expect((body.error.data.diagnostics as { code: string }[]).map((d) => d.code)).toContain('description.missing');

    // Nothing was written: the gate runs before the file and the index.
    const found = await pages.getByTitle('Agent Born Published');
    expect(found).toBeNull();

    // The unattended door is the one an administrator most needs to see refused.
    expect((await refusals()).map((r) => r.payload)).toEqual([
      expect.objectContaining({ reason: 'lint_failed', source: 'mcp', operation: 'create', title: 'Agent Born Published' }),
    ]);
  });

  it('lets an MCP agent create a conformant item published in one call', async () => {
    const body = await callTool('knowledge.create_item', {
      raw_markdown: CONFORMANT.replace('Good Note', 'Agent Conformant'),
      status: 'published',
    });
    expect(body.error).toBeUndefined();
    const found = await pages.getByTitle('Agent Conformant');
    expect(found?.status).toBe('published');
  });

  // --- inbound stays warn-only (deliverable 3) ------------------------------

  it('indexes an inbound file with error-severity diagnostics instead of rejecting it', async () => {
    // Regression guard: `indexFromFile` is the mirror. Refusing an upstream file
    // would break the mirror and silently lose somebody else's content, so a
    // later refactor must not extend the gate to the `git` door.
    const raw = '---\ne3_id: 22222222-2222-4222-8222-222222222222\ntitle: Upstream Note\nstatus: published\n---\nFrom another repo.\n';
    const created = await commands.indexFromFile({
      sourceId: 'main',
      path: 'concepts/upstream-note.md',
      raw,
      digest: digestOf(raw),
      role: 'authoritative',
      actorId: actor.userId,
    });

    expect(created.action).toBe('created');
    expect(created.lintFailed).toBe(true);
    expect(created.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(['type.missing', 'category.missing']));
    // It lands — as a draft, which is the documented warn-mode behaviour.
    expect(created.item.status).toBe('draft');
    expect(await pages.getById(created.item.id)).not.toBeNull();

    // An edit to the same non-conformant file still lands too.
    const edited = raw.replace('From another repo.', 'Edited upstream, still non-conformant.');
    const updated = await commands.indexFromFile({
      sourceId: 'main',
      path: 'concepts/upstream-note.md',
      raw: edited,
      digest: digestOf(edited),
      role: 'authoritative',
      actorId: actor.userId,
    });
    expect(updated.action).toBe('updated');
    expect(updated.lintFailed).toBe(true);
    expect(updated.item.body_markdown).toContain('Edited upstream');

    // Nothing was refused, so nothing is audited as a refusal: an inbound file
    // queues in Content health instead.
    expect(await refusals()).toEqual([]);
  });

  // --- the override (deliverable 2) -----------------------------------------

  it('lets an admin publish over the diagnostics with allow_lint_errors, and records it in the audit log', async () => {
    const item = await draft();

    const res = await request(app.getHttpServer())
      .put(`/api/v1/items/${item.id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(item.version_token))
      .send({ status: 'published', allow_lint_errors: true })
      .expect(200);
    expect(res.body.item.status).toBe('published');

    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'content.publish_lint_override')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: actor.userId, page_id: item.id });
    const payload = JSON.parse(rows[0]!.payload_json!);
    expect(payload.source).toBe('rest');
    expect(payload.diagnostics.map((d: { code: string }) => d.code).sort()).toEqual([
      'category.missing',
      'description.missing',
    ]);

    // The flag is not a stored field: it never reaches the document.
    expect(res.body.item.frontmatter['allow_lint_errors']).toBeUndefined();
  });

  it('refuses the override to a non-admin rather than silently ignoring it', async () => {
    const alice = await seedUserAndLogin(app);
    const aliceActor = actorFrom({ id: alice.userId, username: 'alice', role: 'user' }, 'rest');
    const own = await commands.create(aliceActor, { raw: NON_CONFORMANT.replace('Legacy Note', 'Alice Note') }, 'rest');

    const res = await request(app.getHttpServer())
      .put(`/api/v1/items/${own.item.id}`)
      .set('Cookie', alice.cookie)
      .set('If-Match', String(own.item.version_token))
      .send({ status: 'published', allow_lint_errors: true })
      .expect(403);
    expect(res.body.reason).toBe('lint_override_forbidden');

    expect((await pages.getById(own.item.id))!.status).toBe('draft');
    expect(await db.selectFrom('audit_log').selectAll().where('action', '=', 'content.publish_lint_override').execute()).toEqual([]);
    // Refused, so recorded as a refusal — with the reason that says why.
    expect((await refusals()).map((r) => ({ actor: r.actor_id, ...r.payload }))).toEqual([
      expect.objectContaining({ actor: alice.userId, reason: 'lint_override_forbidden', source: 'rest', operation: 'publish' }),
    ]);
  });

  it('keeps refusals admin-only: a non-admin cannot read them from the audit endpoint', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ raw: NON_CONFORMANT, status: 'published' })
      .expect(422);

    const alice = await seedUserAndLogin(app);
    await request(app.getHttpServer())
      .get('/api/v1/admin/audit?action=content.refused')
      .set('Cookie', alice.cookie)
      .expect(403);

    // The same read an admin makes — what the Content health panel shows.
    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/audit?action=content.refused')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({ action: 'content.refused', actor_username: 'admin' });
    expect(res.body.actions).toContain('content.refused');
  });

  it('does not record an override row when the document needed no override', async () => {
    const good = await draft(CONFORMANT);
    await commands.publish(actor, good.id, { allowLintErrors: true });
    expect(await db.selectFrom('audit_log').selectAll().where('action', '=', 'content.publish_lint_override').execute()).toEqual([]);
  });
});
