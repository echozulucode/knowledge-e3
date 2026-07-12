import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { ItemsService } from '../src/items/items.service.js';

describe('Wiki-link resolution index e2e', () => {
  let app: INestApplication;
  let cookie: string;
  let adminId: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie, userId: adminId } = await seedAdminAndLogin(app));
  });

  afterEach(async () => app.close());

  it('returns the slugs of existing pages for render-time link resolution', async () => {
    const items = app.get(ItemsService);
    const a = await items.create(adminId, { title: 'Finite State Machines', body: 'x', status: 'published' });

    const res = await request(app.getHttpServer()).get('/api/v1/pages/link-index').set('Cookie', cookie).expect(200);
    const slugs: string[] = res.body.slugs;
    expect(slugs).toContain(a.slug);
    expect(slugs).toContain('finite-state-machines');
    // A path-style / unimported reference is absent → renders as a red link.
    expect(slugs).not.toContain('games-open-source-godot');
  });
});
