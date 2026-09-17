import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';

describe('taxonomy e2e', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
  });

  afterEach(async () => app.close());

  it('creates primary categories and lists them with zero usage before item assignment', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/taxonomy/categories')
      .set('Cookie', cookie)
      .send({ name: 'Research Notes' })
      .expect(201);

    expect(created.body.category).toEqual(expect.objectContaining({ name: 'Research Notes', slug: 'research-notes', count: 0 }));

    const categories = await request(app.getHttpServer())
      .get('/api/v1/taxonomy/categories')
      .set('Cookie', cookie)
      .expect(200);
    expect(categories.body.categories).toEqual([expect.objectContaining({ name: 'Research Notes', slug: 'research-notes', count: 0 })]);
  });

  it('rejects blank primary category names with a validation error', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/v1/taxonomy/categories')
      .set('Cookie', cookie)
      .send({ name: '   ' })
      .expect(400);

    expect(rejected.body.message).toContain('primary category name is required');
  });

  it('supports renaming and archiving primary category catalog entries without rewriting assigned items', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({ title: 'Assigned Category Item', body: 'body', frontmatter: { categories: ['architecture'] } })
      .expect(201);

    const created = await request(app.getHttpServer())
      .post('/api/v1/taxonomy/categories')
      .set('Cookie', cookie)
      .send({ name: 'Field Notes' })
      .expect(201);

    expect(created.body.category).toEqual(expect.objectContaining({ slug: 'field-notes', name: 'Field Notes', count: 0 }));

    const renamed = await request(app.getHttpServer())
      .put('/api/v1/taxonomy/categories/field-notes')
      .set('Cookie', cookie)
      .send({ name: 'Research Field Notes' })
      .expect(200);
    expect(renamed.body.category).toEqual(expect.objectContaining({ slug: 'field-notes', name: 'Research Field Notes', count: 0 }));

    await request(app.getHttpServer()).delete('/api/v1/taxonomy/categories/field-notes').set('Cookie', cookie).expect(200);

    const listed = await request(app.getHttpServer()).get('/api/v1/taxonomy/categories').set('Cookie', cookie).expect(200);
    expect(listed.body.categories.map((category: { slug: string }) => category.slug)).toContain('architecture');
    expect(listed.body.categories.map((category: { slug: string }) => category.slug)).not.toContain('field-notes');
  });

  it('creates global and topic-scoped groups for Admin pickers with scope metadata', async () => {
    const topic = await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', cookie)
      .send({ name: 'Research Lab' })
      .expect(201);

    const globalGroup = await request(app.getHttpServer())
      .post('/api/v1/taxonomy/groups')
      .set('Cookie', cookie)
      .send({ name: 'Review Board', scope: 'global' })
      .expect(201);
    expect(globalGroup.body.group).toEqual(
      expect.objectContaining({ name: 'Review Board', slug: 'review-board', count: 0, scope: { type: 'global', space_id: null, space_slug: null } }),
    );

    const scopedGroup = await request(app.getHttpServer())
      .post('/api/v1/taxonomy/groups')
      .set('Cookie', cookie)
      .send({ name: 'Lab Operators', space_id: topic.body.topic.id })
      .expect(201);
    expect(scopedGroup.body.group).toEqual(
      expect.objectContaining({
        name: 'Lab Operators',
        slug: 'lab-operators',
        count: 0,
        scope: { type: 'space', space_id: topic.body.topic.id, space_slug: 'research-lab' },
      }),
    );

    const groups = await request(app.getHttpServer())
      .get('/api/v1/taxonomy/groups?q=lab')
      .set('Cookie', cookie)
      .expect(200);
    expect(groups.body.groups).toEqual([
      expect.objectContaining({ name: 'Lab Operators', scope: expect.objectContaining({ type: 'space', space_slug: 'research-lab' }) }),
    ]);

    const scopedByTopic = await request(app.getHttpServer())
      .get('/api/v1/taxonomy/groups?q=research')
      .set('Cookie', cookie)
      .expect(200);
    expect(scopedByTopic.body.groups).toEqual([
      expect.objectContaining({ name: 'Lab Operators', scope: expect.objectContaining({ space_slug: 'research-lab' }) }),
    ]);
  });

  it('extracts topics, tags, categories, and groups from item frontmatter and lists counts', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/items')
      .set('Cookie', cookie)
      .send({
        raw_markdown:
          '---\ntitle: Taxonomy Item\ntopic: Research Lab\ntags: [ai, mvp]\ncategories: [architecture]\ngroups: [roadmap]\n---\nBody',
      })
      .expect(201);

    expect(created.body.item.tags).toEqual(['ai', 'mvp']);
    expect(created.body.item.categories).toEqual(['architecture']);
    expect(created.body.item.groups).toEqual(['roadmap']);
    expect(created.body.item.space_id).toBe('space_research-lab');

    const createdTopic = await request(app.getHttpServer()).get('/api/v1/topics').set('Cookie', cookie).expect(200);
    expect(createdTopic.body.topics).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'space_research-lab', slug: 'research-lab', name: 'Research Lab' })]),
    );

    const updated = await request(app.getHttpServer())
      .put(`/api/v1/items/${created.body.item.id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(created.body.item.version_token))
      .send({ raw_markdown: '---\ntitle: Taxonomy Item\ntopic: Capture Inbox\ntags: [ai]\ncategories: [design]\ngroups: [roadmap, mcp]\n---\nBody v2' })
      .expect(200);

    expect(updated.body.item.space_id).toBe('space_capture-inbox');

    const tags = await request(app.getHttpServer()).get('/api/v1/taxonomy/tags').set('Cookie', cookie).expect(200);
    expect(tags.body.tags).toEqual([expect.objectContaining({ name: 'ai', count: 1 })]);

    const categories = await request(app.getHttpServer())
      .get('/api/v1/taxonomy/categories')
      .set('Cookie', cookie)
      .expect(200);
    expect(categories.body.categories).toEqual([expect.objectContaining({ name: 'design', count: 1 })]);

    const groups = await request(app.getHttpServer()).get('/api/v1/taxonomy/groups').set('Cookie', cookie).expect(200);
    expect(groups.body.groups.map((group: { slug: string; count: number }) => [group.slug, group.count])).toEqual([
      ['mcp', 1],
      ['roadmap', 1],
    ]);
  });
});

/**
 * Admin taxonomy writes added for the Tags & groups and Primary categories
 * pages (the admin UX review §4.6): the archived category list and
 * restore (the page's Undo), and group edit and archive (refused while in use). No category or group write is audited (only a topic's visibility
 * flip is), so there are no audit rows to assert.
 */
describe('taxonomy admin writes e2e', () => {
  let app: INestApplication;
  let cookie: string;
  let userCookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
    ({ cookie: userCookie } = await seedUserAndLogin(app, 'alice'));
  });

  afterEach(async () => app.close());

  const http = () => request(app.getHttpServer());

  async function itemWith(frontmatter: Record<string, unknown>, title = 'Taxonomy Fixture') {
    const res = await http().post('/api/v1/items').set('Cookie', cookie).send({ title, body: 'body', frontmatter }).expect(201);
    return res.body.item as { id: string };
  }

  describe('primary categories', () => {
    it('lists an archived category that items still carry with its usage count, and restores it', async () => {
      // Archiving an in-use term stays allowed on the API (it is how new
      // publishes into it are stopped — publish-lint-gate.e2e); the admin page
      // only offers Archive for unused terms.
      await http().post('/api/v1/taxonomy/categories').set('Cookie', cookie).send({ name: 'Runbooks' }).expect(201);
      await itemWith({ categories: ['runbooks'] }, 'First Runbook');
      await itemWith({ categories: ['runbooks'] }, 'Second Runbook');
      await http().delete('/api/v1/taxonomy/categories/runbooks').set('Cookie', cookie).expect(200);

      const archived = await http().get('/api/v1/taxonomy/categories/archived').set('Cookie', cookie).expect(200);
      expect(archived.body.categories).toEqual([expect.objectContaining({ slug: 'runbooks', name: 'Runbooks', count: 2 })]);

      await http().post('/api/v1/taxonomy/categories/runbooks/restore').set('Cookie', cookie).expect(200);
      const curated = await http().get('/api/v1/taxonomy/categories?curated=1').set('Cookie', cookie).expect(200);
      expect(curated.body.categories).toEqual([expect.objectContaining({ slug: 'runbooks', name: 'Runbooks', count: 2 })]);
    });

    it('lists archived categories and restores one, round trip', async () => {
      await http().post('/api/v1/taxonomy/categories').set('Cookie', cookie).send({ name: 'Old Notes' }).expect(201);
      await http().delete('/api/v1/taxonomy/categories/old-notes').set('Cookie', cookie).expect(200);

      const archived = await http().get('/api/v1/taxonomy/categories/archived').set('Cookie', cookie).expect(200);
      expect(archived.body.total).toBe(1);
      expect(archived.body.categories).toEqual([
        expect.objectContaining({ slug: 'old-notes', name: 'Old Notes', count: 0, archived_at: expect.any(String) }),
      ]);
      const active = await http().get('/api/v1/taxonomy/categories?curated=1').set('Cookie', cookie).expect(200);
      expect(active.body.categories.map((c: { slug: string }) => c.slug)).not.toContain('old-notes');

      // Creating the slug again says to restore, rather than "already exists" with nothing on the list.
      const duplicate = await http().post('/api/v1/taxonomy/categories').set('Cookie', cookie).send({ name: 'Old Notes' }).expect(409);
      expect(duplicate.body.message).toContain('restore it instead');

      const restored = await http().post('/api/v1/taxonomy/categories/old-notes/restore').set('Cookie', cookie).expect(200);
      expect(restored.body.category).toEqual(expect.objectContaining({ slug: 'old-notes', name: 'Old Notes', count: 0 }));

      const after = await http().get('/api/v1/taxonomy/categories?curated=1').set('Cookie', cookie).expect(200);
      expect(after.body.categories.map((c: { slug: string }) => c.slug)).toContain('old-notes');
      const archivedAfter = await http().get('/api/v1/taxonomy/categories/archived').set('Cookie', cookie).expect(200);
      expect(archivedAfter.body.categories).toEqual([]);
    });

    it('restore answers 404 for an unknown slug and 409 for a category that is not archived', async () => {
      await http().post('/api/v1/taxonomy/categories/nope/restore').set('Cookie', cookie).expect(404);
      await http().post('/api/v1/taxonomy/categories').set('Cookie', cookie).send({ name: 'Live' }).expect(201);
      const refused = await http().post('/api/v1/taxonomy/categories/live/restore').set('Cookie', cookie).expect(409);
      expect(refused.body.message).toBe('primary category is not archived');
    });

    it('keeps the archived list and restore admin-only', async () => {
      await http().post('/api/v1/taxonomy/categories').set('Cookie', cookie).send({ name: 'Gone' }).expect(201);
      await http().delete('/api/v1/taxonomy/categories/gone').set('Cookie', cookie).expect(200);

      await http().get('/api/v1/taxonomy/categories/archived').set('Cookie', userCookie).expect(403);
      await http().post('/api/v1/taxonomy/categories/gone/restore').set('Cookie', userCookie).expect(403);
      await http().get('/api/v1/taxonomy/categories/archived').expect(401);
      await http().post('/api/v1/taxonomy/categories/gone/restore').expect(401);

      const archived = await http().get('/api/v1/taxonomy/categories/archived').set('Cookie', cookie).expect(200);
      expect(archived.body.categories.map((c: { slug: string }) => c.slug)).toEqual(['gone']);
    });
  });

  describe('groups', () => {
    it('edits name, description and where a group is available, keeping its slug and id', async () => {
      const topic = await http().post('/api/v1/topics').set('Cookie', cookie).send({ name: 'Research Lab' }).expect(201);
      const created = await http().post('/api/v1/taxonomy/groups').set('Cookie', cookie).send({ name: 'Review Board', scope: 'global' }).expect(201);
      const id = created.body.group.id as string;

      const scoped = await http()
        .put(`/api/v1/taxonomy/groups/${id}`)
        .set('Cookie', cookie)
        .send({ name: 'Design Review Board', description: 'Signs off designs.', space_id: topic.body.topic.id })
        .expect(200);
      expect(scoped.body.group).toEqual(
        expect.objectContaining({
          id,
          slug: 'review-board',
          name: 'Design Review Board',
          description: 'Signs off designs.',
          scope: { type: 'space', space_id: topic.body.topic.id, space_slug: 'research-lab' },
        }),
      );

      // A plain rename keeps the scope and the description.
      const renamed = await http().put(`/api/v1/taxonomy/groups/${id}`).set('Cookie', cookie).send({ name: 'Board' }).expect(200);
      expect(renamed.body.group).toEqual(
        expect.objectContaining({ name: 'Board', description: 'Signs off designs.', scope: expect.objectContaining({ type: 'space' }) }),
      );

      // "All topics", and a cleared description.
      const global = await http().put(`/api/v1/taxonomy/groups/${id}`).set('Cookie', cookie).send({ scope: 'global', description: null }).expect(200);
      expect(global.body.group).toEqual(
        expect.objectContaining({ name: 'Board', description: null, scope: { type: 'global', space_id: null, space_slug: null } }),
      );

      const listed = await http().get('/api/v1/taxonomy/groups').set('Cookie', cookie).expect(200);
      expect(listed.body.groups).toEqual([expect.objectContaining({ id, name: 'Board', description: null })]);
    });

    it('rejects a blank name, an unknown topic and an unknown group', async () => {
      const created = await http().post('/api/v1/taxonomy/groups').set('Cookie', cookie).send({ name: 'Ops' }).expect(201);
      const id = created.body.group.id as string;
      const blank = await http().put(`/api/v1/taxonomy/groups/${id}`).set('Cookie', cookie).send({ name: '  ' }).expect(400);
      expect(blank.body.message).toContain('group name is required');
      await http().put(`/api/v1/taxonomy/groups/${id}`).set('Cookie', cookie).send({ space_id: 'space_missing' }).expect(404);
      await http().put('/api/v1/taxonomy/groups/group_missing').set('Cookie', cookie).send({ name: 'X' }).expect(404);
      await http().delete('/api/v1/taxonomy/groups/group_missing').set('Cookie', cookie).expect(404);
    });

    it('archives an unused group and refuses one items are in, naming how many', async () => {
      const unused = await http().post('/api/v1/taxonomy/groups').set('Cookie', cookie).send({ name: 'Unused Crew' }).expect(201);
      await itemWith({ groups: ['roadmap'] });

      const refused = await http().delete('/api/v1/taxonomy/groups/group_roadmap').set('Cookie', cookie).expect(409);
      expect(refused.body.message).toBe('group is in use by 1 item');

      const archived = await http().delete(`/api/v1/taxonomy/groups/${unused.body.group.id}`).set('Cookie', cookie).expect(200);
      expect(archived.body.group).toEqual(expect.objectContaining({ slug: 'unused-crew', count: 0 }));

      const listed = await http().get('/api/v1/taxonomy/groups').set('Cookie', cookie).expect(200);
      expect(listed.body.groups.map((g: { slug: string }) => g.slug)).toEqual(['roadmap']);
      // An archived group is gone for edits too.
      await http().put(`/api/v1/taxonomy/groups/${unused.body.group.id}`).set('Cookie', cookie).send({ name: 'Back' }).expect(404);
    });

    it('keeps group edit and archive admin-only', async () => {
      const created = await http().post('/api/v1/taxonomy/groups').set('Cookie', cookie).send({ name: 'Guarded' }).expect(201);
      const id = created.body.group.id as string;

      await http().put(`/api/v1/taxonomy/groups/${id}`).set('Cookie', userCookie).send({ name: 'Hijacked' }).expect(403);
      await http().delete(`/api/v1/taxonomy/groups/${id}`).set('Cookie', userCookie).expect(403);
      await http().put(`/api/v1/taxonomy/groups/${id}`).send({ name: 'Hijacked' }).expect(401);
      await http().delete(`/api/v1/taxonomy/groups/${id}`).expect(401);

      const listed = await http().get('/api/v1/taxonomy/groups').set('Cookie', cookie).expect(200);
      expect(listed.body.groups).toEqual([expect.objectContaining({ id, name: 'Guarded' })]);
    });
  });
});
