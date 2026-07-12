import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';

describe('Sections (type × space) HTTP e2e', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
  });

  afterEach(async () => app.close());

  async function createPage(title: string, type: string) {
    await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({ title, body: 'x', status: 'published', frontmatter: { type } })
      .expect(201);
  }

  it('curates sections (admin) and filters the listing by section type', async () => {
    await createPage('Launch Notes', 'blog');
    await createPage('Billing FAQ', 'faq');

    // Admin curates a Blog section.
    const put = await request(app.getHttpServer())
      .put('/api/v1/sections')
      .set('Cookie', cookie)
      .send({ sections: [{ name: 'Blog', type: 'blog', description: 'Posts' }] })
      .expect(200);
    expect(put.body.sections[0]).toMatchObject({ slug: 'blog', name: 'Blog', type: 'blog' });

    // The section is readable.
    const got = await request(app.getHttpServer()).get('/api/v1/sections').set('Cookie', cookie).expect(200);
    expect(got.body.sections.map((s: { slug: string }) => s.slug)).toContain('blog');

    // Listing filtered by the section's type returns only that section's items.
    const list = await request(app.getHttpServer())
      .get('/api/v1/pages?type=blog')
      .set('Cookie', cookie)
      .expect(200);
    const titles = list.body.items.map((i: { title: string }) => i.title);
    expect(titles).toContain('Launch Notes');
    expect(titles).not.toContain('Billing FAQ');
    // The type is exposed on the listed item.
    expect(list.body.items[0].type).toBe('blog');
  });

  it('only admins may curate sections', async () => {
    const alice = await seedUserAndLogin(app);
    await request(app.getHttpServer())
      .put('/api/v1/sections')
      .set('Cookie', alice.cookie)
      .send({ sections: [{ name: 'Nope' }] })
      .expect(403);
  });
});
