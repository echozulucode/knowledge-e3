/**
 * Sections as landing-page slots (plan §3.2): `slot`, `order`, `limit` round-trip
 * through PUT /sections, are validated, and order the listing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';

describe('Sections slots HTTP e2e', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
  });

  afterEach(async () => app.close());

  function put(sections: unknown[]) {
    return request(app.getHttpServer()).put('/api/v1/sections').set('Cookie', cookie).send({ sections });
  }

  it('round-trips slot, order and limit and lists sections by order then name', async () => {
    const res = await put([
      { name: 'Zeta', type: 'faq' },
      { name: 'Advanced', type: 'deep-dive', slot: 'advanced', order: 3, limit: 5 },
      { name: 'Start here', type: 'guide', space: 'default', slot: 'start-here', order: 1, limit: 1 },
      { name: 'Alpha', type: 'note' },
      { name: 'Examples', type: 'example', slot: 'examples', order: 2 },
    ]).expect(200);
    expect(res.body.sections.map((s: { slug: string }) => s.slug)).toEqual(['start-here', 'examples', 'advanced', 'alpha', 'zeta']);
    expect(res.body.sections[0]).toEqual({ slug: 'start-here', name: 'Start here', type: 'guide', space: 'default', slot: 'start-here', order: 1, limit: 1 });
    expect(res.body.sections[1]).toEqual({ slug: 'examples', name: 'Examples', type: 'example', slot: 'examples', order: 2 });
    // Sections without slot fields are stored without them (pre-slot shape preserved).
    expect(res.body.sections[3]).toEqual({ slug: 'alpha', name: 'Alpha', type: 'note' });

    const got = await request(app.getHttpServer()).get('/api/v1/sections').set('Cookie', cookie).expect(200);
    expect(got.body.sections).toEqual(res.body.sections);
  });

  it('rejects an invalid slot, order, or limit with 400', async () => {
    await put([{ name: 'Bad slot', slot: 'sidebar' }]).expect(400);
    await put([{ name: 'Bad order', order: 'first' }]).expect(400);
    await put([{ name: 'Too many', limit: 51 }]).expect(400);
    await put([{ name: 'Too few', limit: 0 }]).expect(400);
    await put([{ name: 'Fraction', limit: 2.5 }]).expect(400);
    // Nothing was stored by the failed writes.
    const got = await request(app.getHttpServer()).get('/api/v1/sections').set('Cookie', cookie).expect(200);
    expect(got.body.sections).toEqual([]);
  });
});
