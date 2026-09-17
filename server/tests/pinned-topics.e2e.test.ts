/**
 * Pinned topics — the home page's featured topics (home-prototype plan §3.3/§4).
 *
 * Two assertions here carry real weight and the rest support them:
 *
 *  - **Only an administrator may curate the list.** That is the whole of Eric's
 *    constraint: "this pinning should only be set by the system admin and not by
 *    individuals." A signed-in non-admin and an anonymous visitor must both be
 *    refused the write.
 *  - **A pinned private topic must not become public.** `visibility: 'private'`
 *    means "not exposed to anonymous visitors", and pinning must never be a way
 *    around it — otherwise an administrator putting a topic on the front page
 *    would publish its name, its description and its cover image to everyone.
 *    Resolution therefore happens server-side, per viewer.
 *
 * The cover-image test is the third: a chrome image is embedded in no published
 * page, so `/assets/<file>` would 404 for the anonymous visitor who is this
 * product's DEFAULT reader — the same trap the site logo fell into, answered by
 * the same predicate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { ConfigService } from '../src/config/config.service.js';
import { resetServerConfig } from '../src/config/server-config.js';

/** A tiny valid 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

interface PinView {
  topic: string;
  name: string | null;
  description: string | null;
  color: string | null;
  icon: string | null;
  cover: string | null;
  cover_dark: string | null;
}

describe('Pinned topics', () => {
  let app: INestApplication;
  let cookie: string;
  let assetsDir: string;

  beforeEach(async () => {
    assetsDir = mkdtempSync(join(tmpdir(), 'e3-pins-'));
    process.env['KNOWLEDGE_E3_ASSETS_DIR'] = assetsDir;
    app = await makeApp();
    cookie = (await seedAdminAndLogin(app)).cookie;
  });

  afterEach(async () => {
    await app.close();
    delete process.env['KNOWLEDGE_E3_ASSETS_DIR'];
    rmSync(assetsDir, { recursive: true, force: true });
    // Clears the admin-declared asset registry so one test's covers cannot
    // grant the next test's anonymous visitor anything.
    resetServerConfig();
  });

  function makeTopic(slug: string, extra: Record<string, unknown> = {}) {
    return request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', cookie)
      .send({ name: slug, slug, ...extra })
      .expect(201);
  }

  function putPins(pinned: unknown[], status = 200) {
    return request(app.getHttpServer()).put('/api/v1/site/pinned').set('Cookie', cookie).send({ pinned }).expect(status);
  }

  async function getPins(as?: string): Promise<PinView[]> {
    const req = request(app.getHttpServer()).get('/api/v1/site/pinned');
    if (as) req.set('Cookie', as);
    return (await req.expect(200)).body.pinned as PinView[];
  }

  it('answers with an empty list before anyone has curated one', async () => {
    expect(await getPins(cookie)).toEqual([]);
    expect(await getPins()).toEqual([]);
  });

  it('resolves a pin to its topic, in the curator order, with the colour and both covers', async () => {
    await makeTopic('ai', { description: 'Everything about AI.' });
    await makeTopic('widget-pro', { description: 'The product.' });

    await putPins([
      { topic: 'widget-pro', color: 'ochre', cover: '/assets/aaaa1111.png', cover_dark: '/assets/bbbb2222.png' },
      { topic: 'ai', color: 'teal' },
    ]);

    const pins = await getPins(cookie);
    // The tenant's order, not alphabetical: "the second card" has to be a thing
    // a person can say in a ticket.
    expect(pins.map((p) => p.topic)).toEqual(['widget-pro', 'ai']);
    expect(pins[0]).toMatchObject({
      name: 'widget-pro',
      description: 'The product.',
      color: 'ochre',
      cover: '/assets/aaaa1111.png',
      cover_dark: '/assets/bbbb2222.png',
    });
    // A pin with a colour and no image is the expected common case — a tenant
    // pins four topics and has two logos — and must resolve cleanly.
    expect(pins[1]).toMatchObject({ name: 'ai', color: 'teal', cover: null, cover_dark: null });
  });

  it('falls the dark cover back to the light one server-side, as logo_dark does', async () => {
    await makeTopic('ai');
    await putPins([{ topic: 'ai', cover: '/assets/only1111.png' }]);
    const [pin] = await getPins(cookie);
    expect(pin).toMatchObject({ cover: '/assets/only1111.png', cover_dark: '/assets/only1111.png' });
  });

  it('drops a malformed colour and a malformed cover without dropping the pin', async () => {
    await makeTopic('ai');
    await putPins([
      {
        topic: 'ai',
        // Never a raw hex, and never an arbitrary string: a tenant colour must
        // not reach CSS, and only the named palette has a value per theme.
        color: '#ff0000',
        // The same URL rule the site logo gets: a filesystem path is not a URL.
        cover: 'C:/logos/acme.png',
      },
    ]);
    const [pin] = await getPins(cookie);
    expect(pin).toMatchObject({ topic: 'ai', name: 'ai', color: null, cover: null });
  });

  it('keeps an icon token from the closed list, and drops anything else without dropping the pin', async () => {
    await makeTopic('ai');
    await makeTopic('ops');
    await makeTopic('hex');
    await putPins([
      { topic: 'ai', color: 'teal', icon: 'bookOpen' },
      // Case matters: the tokens are `appIcons` keys, and `bookopen` names no glyph.
      { topic: 'ops', icon: 'bookopen' },
      // Never markup or a URL: the web app maps a token to a glyph, nothing else.
      { topic: 'hex', icon: '<svg onload=alert(1)>' },
    ]);
    const pins = await getPins(cookie);
    expect(pins.map((p) => [p.topic, p.icon])).toEqual([
      ['ai', 'bookOpen'],
      ['ops', null],
      ['hex', null],
    ]);
    // The stored definition carries the token too, so an admin editor round-trips it.
    const stored = await app.get(ConfigService).getPinnedTopics();
    expect(stored[0]).toMatchObject({ topic: 'ai', color: 'teal', icon: 'bookOpen' });
    expect(stored[1]).not.toHaveProperty('icon');
    // And an anonymous visitor sees the same icon the admin chose.
    expect((await getPins())[0]).toMatchObject({ topic: 'ai', icon: 'bookOpen' });
  });

  it('caps the list at six, and drops an entry that names no topic at all', async () => {
    for (const slug of ['t1', 't2', 't3', 't4', 't5', 't6', 't7']) await makeTopic(slug);
    await putPins([
      ...['t1', 't2', 't3', 't4', 't5', 't6', 't7'].map((topic) => ({ topic })),
      { color: 'teal' },
    ]);
    expect((await getPins(cookie)).map((p) => p.topic)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
  });

  it('keeps a pinned PRIVATE topic off the page for an anonymous visitor', async () => {
    await makeTopic('open', { description: 'Public.' });
    await makeTopic('secret', { visibility: 'private', description: 'Not public.' });
    await putPins([
      { topic: 'secret', color: 'plum', cover: '/assets/secret11.png' },
      { topic: 'open', color: 'teal' },
    ]);

    // The administrator who pinned it still sees it.
    expect((await getPins(cookie)).map((p) => p.topic)).toEqual(['secret', 'open']);

    // The anonymous visitor gets neither the name, the description nor the
    // cover URL — pinning is not a way around `visibility: private`.
    const anon = await getPins();
    expect(anon.map((p) => p.topic)).toEqual(['open']);
    expect(JSON.stringify(anon)).not.toContain('secret');
  });

  it('drops a pin naming a topic that does not exist, but keeps it for an admin to fix', async () => {
    await makeTopic('ai');
    await putPins([{ topic: 'ghost' }, { topic: 'ai' }]);

    // A typo in one pin must never cost the site its front page.
    expect((await getPins()).map((p) => p.topic)).toEqual(['ai']);

    // The admin keeps the dead row, marked by a null name, so the editor can
    // show it rather than silently eating what they typed.
    const asAdmin = await getPins(cookie);
    expect(asAdmin.map((p) => p.topic)).toEqual(['ghost', 'ai']);
    expect(asAdmin[0]?.name).toBeNull();
  });

  it('lets only an administrator curate the list', async () => {
    await makeTopic('ai');
    await putPins([{ topic: 'ai', color: 'teal' }]);

    // A signed-in non-admin: this is the "not by individuals" half.
    const { cookie: userCookie } = await seedUserAndLogin(app);
    await request(app.getHttpServer())
      .put('/api/v1/site/pinned')
      .set('Cookie', userCookie)
      .send({ pinned: [{ topic: 'ai', color: 'plum' }] })
      .expect(403);

    // And an anonymous visitor.
    await request(app.getHttpServer())
      .put('/api/v1/site/pinned')
      .send({ pinned: [] })
      .expect(401);

    // Nothing the refused writes asked for happened.
    expect((await getPins(cookie))[0]).toMatchObject({ topic: 'ai', color: 'teal' });
  });

  it('serves a pinned cover to an anonymous visitor, which nothing else would', async () => {
    await makeTopic('ai');
    const upload = await request(app.getHttpServer())
      .post('/api/v1/images')
      .set('Cookie', cookie)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(201);
    const url = upload.body.url as string;

    // Before it is pinned: no published page embeds a chrome image, so the
    // anonymous visitor who is this product's default reader gets a 404. This
    // half is what makes the next one mean something.
    await request(app.getHttpServer()).get(url).expect(404);
    await request(app.getHttpServer()).get(url).set('Cookie', cookie).expect(200);

    await putPins([{ topic: 'ai', cover: url }]);

    // Declaring it on the front page is the administrator saying it is part of
    // the public face of the instance, so it is served on those terms.
    const served = await request(app.getHttpServer()).get(url).expect(200);
    expect(served.headers['content-type']).toContain('image/png');
    expect(served.headers['cache-control']).toContain('public');

    // Unpinning takes the grant away again.
    await putPins([]);
    await request(app.getHttpServer()).get(url).expect(404);
  });

  it('serves a pinned cover anonymously after a restart, with nobody having read the pins first', async () => {
    await makeTopic('ai');
    const upload = await request(app.getHttpServer())
      .post('/api/v1/images')
      .set('Cookie', cookie)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(201);
    const url = upload.body.url as string;
    await putPins([{ topic: 'ai', cover: url }]);

    // Simulate the cold-boot ordering: forget everything the running process
    // has declared, then have the app prime itself the way it does at startup.
    // Without that priming the first request for the cover would 404 — the very
    // request that needs it.
    resetServerConfig();
    await request(app.getHttpServer()).get(url).expect(404);
    await app.get(ConfigService).onModuleInit();
    await request(app.getHttpServer()).get(url).expect(200);
  });
});
