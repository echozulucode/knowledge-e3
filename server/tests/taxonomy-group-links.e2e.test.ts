/**
 * Frontmatter group links resolve to the group row that owns the slug (issue
 * 117). A group an admin created for one topic has the id
 * `group_<topic>_<slug>`; an item naming that slug in frontmatter used to be
 * linked as `group_<slug>` — an id that does not exist, so the save failed on
 * the foreign key (or left a dangling link where the key was not enforced) and
 * the item was missing from the group's count, facet and FTS column.
 *
 * An ARCHIVED group named in frontmatter is linked to the archived row, stays
 * archived, and the lint says so as a warning (`group.archived`) — advisory,
 * never a publish refusal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { sql, type Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY, makeKysely } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { migrateSqlite } from '../src/db/migrations.js';
import { ContentCommandsService } from '../src/content/content-commands.service.js';
import { actorFrom, type ServerActor } from '../src/content/actor.js';

describe('frontmatter group links (issue 117)', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let cookie: string;
  let actor: ServerActor;
  let commands: ContentCommandsService;

  beforeEach(async () => {
    app = await makeApp();
    const login = await seedAdminAndLogin(app);
    cookie = login.cookie;
    actor = actorFrom({ id: login.userId, username: 'admin', role: 'admin' }, 'rest');
    db = app.get<Kysely<Database>>(KYSELY);
    commands = app.get(ContentCommandsService);
  });
  afterEach(async () => app.close());

  const http = () => request(app.getHttpServer());

  async function linksOf(pageId: string): Promise<string[]> {
    const rows = await db.selectFrom('page_groups').select('group_id').where('page_id', '=', pageId).orderBy('group_id').execute();
    return rows.map((r) => r.group_id);
  }

  async function ftsIds(match: string): Promise<string[]> {
    const rows = await sql<{ page_id: string }>`SELECT page_id FROM pages_fts WHERE pages_fts MATCH ${match}`.execute(db);
    return rows.rows.map((row) => row.page_id).sort();
  }

  async function topicScopedGroup(): Promise<{ id: string; topicId: string }> {
    const topic = await http().post('/api/v1/topics').set('Cookie', cookie).send({ name: 'Research Lab' }).expect(201);
    const group = await http()
      .post('/api/v1/taxonomy/groups')
      .set('Cookie', cookie)
      .send({ name: 'Lab Operators', space_id: topic.body.topic.id })
      .expect(201);
    return { id: group.body.group.id as string, topicId: topic.body.topic.id as string };
  }

  it('links an item naming a topic-scoped group to that group’s real id, counted, faceted and searchable', async () => {
    const { id } = await topicScopedGroup();
    expect(id).toBe('group_research-lab_lab-operators');

    const created = await http()
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Shift Roster', body: 'Who is on shift.', frontmatter: { topic: 'Research Lab', groups: ['lab-operators'] } })
      .expect(201);
    const itemId = created.body.item.id as string;

    expect(await linksOf(itemId)).toEqual([id]);
    expect(created.body.item.groups).toEqual(['lab-operators']);

    const groups = await http().get('/api/v1/taxonomy/groups').set('Cookie', cookie).expect(200);
    expect(groups.body.groups).toEqual([expect.objectContaining({ id, slug: 'lab-operators', count: 1 })]);

    const faceted = await http().get('/api/v1/search').query({ q: 'shift', group: 'lab-operators' }).set('Cookie', cookie).expect(200);
    expect(faceted.body.results.map((hit: { id: string }) => hit.id)).toEqual([itemId]);
    // The group NAME is FTS text for the item (the admin's name, not the slug).
    expect(await ftsIds('groups:operators')).toEqual([itemId]);
  });

  it('re-saving the item keeps one link per group, and a slug spelled two ways is linked once', async () => {
    const { id } = await topicScopedGroup();
    const created = await http()
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Shift Roster', body: 'v1', frontmatter: { topic: 'Research Lab', groups: ['lab-operators', 'Lab Operators'] } })
      .expect(201);
    const itemId = created.body.item.id as string;
    expect(await linksOf(itemId)).toEqual([id]);

    await http()
      .put(`/api/v1/items/${itemId}`)
      .set('Cookie', cookie)
      .set('If-Match', String(created.body.version_token))
      .send({ title: 'Shift Roster', body: 'v2', frontmatter: { topic: 'Research Lab', groups: ['lab-operators'] } })
      .expect(200);
    expect(await linksOf(itemId)).toEqual([id]);

    const groups = await http().get('/api/v1/taxonomy/groups').set('Cookie', cookie).expect(200);
    expect(groups.body.groups).toEqual([expect.objectContaining({ id, count: 1 })]);
    const rows = await db.selectFrom('groups').select('id').execute();
    expect(rows.map((r) => r.id)).toEqual([id]);
  });

  it('links an item naming an ARCHIVED group to the archived row, leaves it archived, and warns', async () => {
    const created = await http().post('/api/v1/taxonomy/groups').set('Cookie', cookie).send({ name: 'Night Watch', scope: 'global' }).expect(201);
    const id = created.body.group.id as string;
    await http().delete(`/api/v1/taxonomy/groups/${id}`).set('Cookie', cookie).expect(200);

    const raw = '---\ntitle: Watch Bill\ntype: Concept\ncategories: [guides]\ngroups: [night-watch]\n---\nWho stands which watch.\n';
    const result = await commands.create(actor, { raw }, 'rest');
    const itemId = result.item.id;

    expect(await linksOf(itemId)).toEqual([id]);
    const row = await db.selectFrom('groups').select(['id', 'archived_at']).where('slug', '=', 'night-watch').executeTakeFirstOrThrow();
    expect(row).toEqual({ id, archived_at: expect.any(String) });

    // Advisory: a warning on the write and on a standalone lint — never an error.
    const onWrite = result.diagnostics.filter((d) => d.code === 'group.archived');
    expect(onWrite).toEqual([expect.objectContaining({ severity: 'warning', path: 'groups', message: 'Group "night-watch" is archived' })]);
    const linted = await commands.lint(raw, {});
    expect(linted.filter((d) => d.code === 'group.archived')).toHaveLength(1);
    // An active group draws no such warning.
    const clean = await commands.lint(raw.replace('night-watch', 'day-watch'), {});
    expect(clean.map((d) => d.code)).not.toContain('group.archived');

    // Still hidden from the Groups list and pickers; archive and edit still treat it as gone.
    const groups = await http().get('/api/v1/taxonomy/groups').set('Cookie', cookie).expect(200);
    expect(groups.body.groups.map((g: { slug: string }) => g.slug)).not.toContain('night-watch');
    await http().delete(`/api/v1/taxonomy/groups/${id}`).set('Cookie', cookie).expect(404);
    // The archived row's usage is truthful: the one item that names it.
    const usage = await db.selectFrom('page_groups').select(({ fn }) => fn.count<number>('page_id').as('n')).where('group_id', '=', id).executeTakeFirstOrThrow();
    expect(Number(usage.n)).toBe(1);
  });

  it('does not refuse publishing an item into an archived group (advisory only)', async () => {
    await http().post('/api/v1/taxonomy/categories').set('Cookie', cookie).send({ slug: 'guides', name: 'Guides' }).expect(201);
    const created = await http().post('/api/v1/taxonomy/groups').set('Cookie', cookie).send({ name: 'Night Watch' }).expect(201);
    await http().delete(`/api/v1/taxonomy/groups/${created.body.group.id}`).set('Cookie', cookie).expect(200);

    const raw =
      '---\ntitle: Watch Bill\ntype: Concept\ndescription: Who stands which watch.\ncategories: [guides]\ngroups: [night-watch]\nstale_after: 2999-01-01\n---\nBody.\n';
    const result = await commands.create(actor, { raw, status: 'published' }, 'rest');
    expect(result.item.status).toBe('published');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toContain('group.archived');
  });
});

describe('page_groups repair migration (issue 117)', () => {
  it('re-points dangling `group_<slug>` links at the row that owns the slug, idempotently', async () => {
    const db = makeKysely({ url: ':memory:', driver: 'sqlite' });
    try {
      await migrateSqlite(db);
      const now = '2026-09-01T00:00:00.000Z';
      await db
        .insertInto('spaces')
        .values({ id: 'space_research-lab', slug: 'research-lab', name: 'Research Lab', description: null, visibility: 'public', presentation: 'wiki', landing_markdown: null, start_here: null, created_at: now, updated_at: now, archived_at: null })
        .execute();
      await db
        .insertInto('groups')
        .values({ id: 'group_research-lab_lab-operators', slug: 'lab-operators', name: 'Lab Operators', description: null, space_id: 'space_research-lab', created_at: now, updated_at: now, archived_at: null })
        .execute();
      for (const id of ['page_a', 'page_b']) {
        await db
          .insertInto('pages')
          .values({ id, slug: id, title: id, status: 'draft', owner_id: null, space_id: 'space_research-lab', created_at: now, updated_at: now, deleted_at: null, version_token: 1, current_version_id: null })
          .execute();
      }
      // What the old sync wrote where the foreign key was not enforced. page_b
      // also already holds the real link, so the repair must not duplicate it.
      await sql`PRAGMA foreign_keys = OFF`.execute(db);
      await db
        .insertInto('page_groups')
        .values([
          { page_id: 'page_a', group_id: 'group_lab-operators' },
          { page_id: 'page_b', group_id: 'group_lab-operators' },
          { page_id: 'page_b', group_id: 'group_research-lab_lab-operators' },
          // No row owns this slug: nothing to point at, so it is left alone.
          { page_id: 'page_a', group_id: 'group_nowhere' },
        ])
        .execute();
      await sql`PRAGMA foreign_keys = ON`.execute(db);

      await migrateSqlite(db);
      await migrateSqlite(db);

      const rows = await db.selectFrom('page_groups').select(['page_id', 'group_id']).orderBy('page_id').orderBy('group_id').execute();
      expect(rows).toEqual([
        { page_id: 'page_a', group_id: 'group_nowhere' },
        { page_id: 'page_a', group_id: 'group_research-lab_lab-operators' },
        { page_id: 'page_b', group_id: 'group_research-lab_lab-operators' },
      ]);
    } finally {
      await db.destroy();
    }
  });
});
