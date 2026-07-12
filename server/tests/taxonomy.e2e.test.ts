import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';

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
