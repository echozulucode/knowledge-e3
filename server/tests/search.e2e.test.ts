import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { conformant, curateCategories, makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { Kysely } from 'kysely';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';

/**
 * Search acceptance tests from spec section 7.4.
 *
 * The recency-aware ranker should:
 *   - rank a recent page above an old page when both match,
 *   - exclude a page that does not match at all (no recency-as-grant-entry),
 *   - support filters (tag, since) and sort modes (newest/oldest/az/relevance),
 *   - exclude drafts by default; include them only when admin and include_drafts=1.
 */
describe('search e2e', () => {
  let app: INestApplication;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
    // Every category a fixture below publishes into: publishing is gated on the
    // curated catalog (issue 98), creates included.
    await curateCategories(app, 'incident-response', 'runbook', 'decision-record', 'research-notes', 'operations', 'access');
  });
  afterEach(async () => app.close());

  async function createPage(
    title: string,
    body: string,
    opts: { status?: 'draft' | 'published'; tags?: string[]; updatedAt?: string; frontmatter?: Record<string, unknown> } = {},
  ): Promise<string> {
    const status = opts.status ?? 'published';
    const res = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({
        title,
        body,
        status,
        tags: opts.tags ?? [],
        // A published fixture must be publishable; a draft keeps exactly what the test gave it.
        frontmatter: status === 'published' ? conformant(opts.frontmatter) : opts.frontmatter ?? {},
      })
      .expect(201);
    if (opts.updatedAt) {
      // Backdate via direct DB write — the service computes updated_at from now,
      // so we patch it for the recency test.
      const db = app.get<Kysely<Database>>(KYSELY);
      await db
        .updateTable('pages')
        .set({ updated_at: opts.updatedAt })
        .where('id', '=', res.body.page.id)
        .execute();
    }
    return res.body.page.id;
  }

  it('surfaces derived OKF trust tier + freshness on hits and in facets', async () => {
    await createPage('Verified Okftermunique Concept', 'okftermunique body content here.', {
      frontmatter: {
        verified: [{ by: 'human:ericjzim', at: '2026-08-05T00:00:00Z' }],
        stale_after: '2000-01-01', // already past ⇒ stale
      },
    });
    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=okftermunique')
      .set('Cookie', cookie)
      .expect(200);
    const hit = res.body.results.find((r: { title: string }) => r.title === 'Verified Okftermunique Concept');
    expect(hit).toBeTruthy();
    expect(hit.trust_tier).toBe('human-reviewed');
    expect(hit.stale).toBe(true);
    expect(
      res.body.facets.trust_tiers.some((f: { value: string }) => f.value === 'human-reviewed'),
    ).toBe(true);
  });

  it('finds pages by title or body', async () => {
    await createPage('Payments Runbook', 'How to handle retries.');
    await createPage('Inventory Doc', 'No relevant content here.');
    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=retries')
      .set('Cookie', cookie)
      .expect(200);
    const titles = res.body.results.map((r: { title: string }) => r.title);
    expect(titles).toContain('Payments Runbook');
    expect(titles).not.toContain('Inventory Doc');
  });

  it('returns trustworthy snippets, match reasons, score, and card metadata', async () => {
    await createPage(
      'Trustworthy Search Card',
      'The escalation checklist explains how to rotate credentials safely during an incident.',
      {
        tags: ['security'],
        frontmatter: {
          topic: 'Ops Handbook',
          categories: ['incident-response'],
          groups: ['on-call'],
          summary: 'Ops-facing incident response article.',
        },
      },
    );

    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=credentials')
      .set('Cookie', cookie)
      .expect(200);

    const hit = res.body.results.find((r: { title: string }) => r.title === 'Trustworthy Search Card');
    expect(hit).toMatchObject({
      slug: expect.any(String),
      status: 'published',
      score: expect.any(Number),
      topic: 'Ops Handbook',
      tags: ['security'],
      categories: ['incident-response'],
      groups: ['on-call'],
    });
    expect(hit.snippet).toContain('credentials');
    expect(hit.matched_fields).toContain('body');
    expect(hit.reasons).toContain('Body match');
  });

  it('ranks a title match above a body-only match for the same query', async () => {
    await createPage(
      'Modbus TCP Setup Guide',
      'This note discusses network transport patterns and port alignment.',
    );
    await createPage(
      'Random Engineering Notes',
      'This random note includes a detailed modbus tcp setup checklist for later reference.',
    );

    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=modbus tcp setup')
      .set('Cookie', cookie)
      .expect(200);

    const titles = res.body.results.map((r: { title: string }) => r.title);
    expect(titles).toEqual(['Modbus TCP Setup Guide', 'Random Engineering Notes']);
  });

  it('returns title/tag/body reasons for mixed matches', async () => {
    await createPage('Modbus Setup Checklist', 'A long note about industrial field buses and setup steps.', {
      tags: ['modbus'],
      frontmatter: { topic: 'Modbus Setup' },
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=modbus setup')
      .set('Cookie', cookie)
      .expect(200);

    const hit = res.body.results.find((r: { title: string }) => r.title === 'Modbus Setup Checklist');
    expect(hit).toBeTruthy();
    expect(hit.matched_fields).toEqual(expect.arrayContaining(['title', 'body', 'tags', 'topic']));
    expect(hit.reasons).toContain('Title match');
    expect(hit.reasons).toContain('Tag: modbus');
    expect(hit.reasons).toContain('Topic: Modbus Setup');
    expect(hit.reasons).toContain('Body match');
  });

  it('can match taxonomy-only text and returns reason labels without HTML formatting', async () => {
    await createPage('Taxonomy Only Match', 'Plain body with no query term.', {
      tags: ['security'],
      frontmatter: { categories: ['runbook'], groups: ['incident-command'] },
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=incident-command')
      .set('Cookie', cookie)
      .expect(200);

    const hit = res.body.results.find((r: { title: string }) => r.title === 'Taxonomy Only Match');
    expect(hit).toBeTruthy();
    expect(hit.matched_fields).toEqual(expect.arrayContaining(['groups']));
    expect(hit.reasons).toContain('Group: incident-command');
    expect(hit.snippet).not.toMatch(/<[^>]+>/);
  });

  it('finds pages whose only match is in the title (not body)', async () => {
    // Match term in title only, body has nothing in common.
    await createPage('Kubernetes Deployment', 'unrelated body text');
    await createPage('Decoy Doc', 'unrelated body text');
    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=kubernetes')
      .set('Cookie', cookie)
      .expect(200);
    const titles = res.body.results.map((r: { title: string }) => r.title);
    expect(titles).toContain('Kubernetes Deployment');
    expect(titles).not.toContain('Decoy Doc');
  });

  it('a non-matching page is not surfaced even if it is fresh (recency multiplies, does not grant entry)', async () => {
    await createPage('Totally Unrelated', 'A page about cats and gardening.', {
      updatedAt: new Date().toISOString(),
    });
    await createPage('Old Retry Doc', 'How retries work in payments.', {
      updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 365 * 3).toISOString(),
    });
    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=retries')
      .set('Cookie', cookie)
      .expect(200);
    const titles = res.body.results.map((r: { title: string }) => r.title);
    expect(titles).toContain('Old Retry Doc');
    expect(titles).not.toContain('Totally Unrelated');
  });

  it('a fresh page with the term ranks above an old page with more hits', async () => {
    await createPage(
      'Old Heavy Hits',
      'retries retries retries retries retries retries retries retries retries retries retries retries.',
      { updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 365 * 3).toISOString() },
    );
    await createPage('Fresh Few Hits', 'retries are the topic of this short page.', {
      updatedAt: new Date().toISOString(),
    });
    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=retries')
      .set('Cookie', cookie)
      .expect(200);
    const titles = res.body.results.map((r: { title: string }) => r.title);
    expect(titles[0]).toBe('Fresh Few Hits');
  });

  it('filter by tag', async () => {
    await createPage('Runbook A', 'Retries.', { tags: ['runbook'] });
    await createPage('Reference A', 'Retries.', { tags: ['reference'] });
    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=retries&tag=runbook')
      .set('Cookie', cookie)
      .expect(200);
    const titles = res.body.results.map((r: { title: string }) => r.title);
    expect(titles).toEqual(['Runbook A']);
  });

  it('applies structured tag filters from the query text', async () => {
    await createPage('Runbook Structured Filter', 'Retries.', { tags: ['runbook'] });
    await createPage('Reference Structured Filter', 'Retries.', { tags: ['reference'] });

    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=tag:runbook retries')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.warnings).toEqual([]);
    expect(res.body.results.map((r: { title: string }) => r.title)).toEqual(['Runbook Structured Filter']);
  });

  it('applies structured topic and space filters from query-only searches', async () => {
    await createPage('Research Topic Match', 'Shared body text.', { frontmatter: { topic: 'Research Notes' } });
    await createPage('Ops Topic Decoy', 'Shared body text.', { frontmatter: { topic: 'Ops Notes' } });

    const topicRes = await request(app.getHttpServer())
      .get('/api/v1/search?q=topic:"Research Notes"')
      .set('Cookie', cookie)
      .expect(200);
    expect(topicRes.body.results.map((r: { title: string }) => r.title)).toEqual(['Research Topic Match']);

    const spaceRes = await request(app.getHttpServer())
      .get('/api/v1/search?q=space:ops-notes')
      .set('Cookie', cookie)
      .expect(200);
    expect(spaceRes.body.results.map((r: { title: string }) => r.title)).toEqual(['Ops Topic Decoy']);
  });

  it('applies structured status filters and keeps draft visibility authorized', async () => {
    await createPage('Published Structured Status', 'Visibility marker.', { status: 'published' });
    await createPage('Draft Structured Status', 'Visibility marker.', { status: 'draft' });
    const { cookie: userCookie } = await seedUserAndLogin(app, 'search-user');

    const adminRes = await request(app.getHttpServer())
      .get('/api/v1/search?q=status:draft visibility')
      .set('Cookie', cookie)
      .expect(200);
    expect(adminRes.body.results.map((r: { title: string }) => r.title)).toEqual(['Draft Structured Status']);

    const userRes = await request(app.getHttpServer())
      .get('/api/v1/search?q=status:draft visibility')
      .set('Cookie', userCookie)
      .expect(200);
    expect(userRes.body.results).toEqual([]);
  });

  it('returns warnings for malformed or unsupported structured filters', async () => {
    await createPage('Warnings Contract Target', 'Parser warnings target.', { tags: ['warnings'] });

    const res = await request(app.getHttpServer())
      // `author:` is a supported key now (reader UX plan §5.2); `created:` is not.
      .get('/api/v1/search?q=tag: created:2026-05-24 is:superseded warnings')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.warnings).toEqual([
      'Malformed structured filter ignored: tag:',
      'Unsupported structured filter ignored: created:2026-05-24',
      expect.stringContaining('Unknown is: value ignored: is:superseded'),
    ]);
    expect(res.body.results.map((r: { title: string }) => r.title)).toEqual(['Warnings Contract Target']);
  });

  it('sort=newest ignores ranking and orders by updated_at desc', async () => {
    await createPage('Old', 'retries.', {
      updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    });
    await createPage('New', 'retries.', { updatedAt: new Date().toISOString() });
    const res = await request(app.getHttpServer())
      .get('/api/v1/search?sort=newest&include_drafts=0')
      .set('Cookie', cookie)
      .expect(200);
    const titles = res.body.results.map((r: { title: string }) => r.title);
    expect(titles[0]).toBe('New');
    expect(titles[1]).toBe('Old');
  });

  it("other users' drafts are excluded by default; admin can opt in with include_drafts=1", async () => {
    await createPage('Public Doc', 'retries.', { status: 'published' });
    // A *different* user's draft must not leak into the admin's default search.
    const other = await seedUserAndLogin(app, 'draftor');
    await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', other.cookie)
      .send({ title: 'Draft Doc', body: 'retries.', status: 'draft', tags: [], frontmatter: {} })
      .expect(201);

    const def = await request(app.getHttpServer())
      .get('/api/v1/search?q=retries')
      .set('Cookie', cookie);
    expect(def.body.results.map((r: { title: string }) => r.title)).toEqual(['Public Doc']);

    const inc = await request(app.getHttpServer())
      .get('/api/v1/search?q=retries&include_drafts=1')
      .set('Cookie', cookie);
    const titles = inc.body.results.map((r: { title: string }) => r.title).sort();
    expect(titles).toEqual(['Draft Doc', 'Public Doc']);
  });

  it('a non-admin sees their OWN draft in search but not another user’s draft (P2-2 parity)', async () => {
    await createPage('Public Doc', 'retries.', { status: 'published' });
    // Admin (the default `cookie`) owns this draft.
    await createPage('Admin Draft', 'retries.', { status: 'draft' });

    const alice = await seedUserAndLogin(app, 'alice');
    // Alice's own draft.
    await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', alice.cookie)
      .send({ title: 'Alice Draft', body: 'retries.', status: 'draft', tags: [], frontmatter: {} })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=retries')
      .set('Cookie', alice.cookie)
      .expect(200);
    const titles = res.body.results.map((r: { title: string }) => r.title).sort();
    // Alice sees the published doc and her own draft, never the admin's draft.
    expect(titles).toEqual(['Alice Draft', 'Public Doc']);
  });

  it('returns realistic engineering search facets, status/recency reasons, and taxonomy snippets', async () => {
    await createPage(
      'CAN Calibration Decision Log',
      [
        '## Decision',
        'Use the measured drift threshold during bench validation instead of a fixed constant.',
        'Command: pnpm --filter @echozedlabs/server test -- --runInBand calibration',
      ].join('\n'),
      {
        tags: ['decision', 'can-bus'],
        frontmatter: {
          topic: 'Engineering Notes',
          categories: ['decision-record'],
          groups: ['scale-testing'],
          summary: 'Decision and command notes from calibration drift validation.',
        },
      },
    );
    await createPage(
      'Long Article: Calibration Notes',
      'A long article describing calibration drift triage, root-cause notes, and follow-up validation across multiple test benches. '.repeat(12),
      {
        tags: ['article'],
        updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 90).toISOString(),
        frontmatter: { topic: 'Engineering Notes', categories: ['research-notes'], groups: ['scale-testing'] },
      },
    );

    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=calibration&status=published')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.total).toBe(2);
    expect(res.body.facets).toMatchObject({
      topics: [expect.objectContaining({ label: 'Engineering Notes', count: 2 })],
      statuses: [expect.objectContaining({ value: 'published', label: 'Published', count: 2, active: true })],
      tags: expect.arrayContaining([
        expect.objectContaining({ value: 'can-bus', count: 1 }),
        expect.objectContaining({ value: 'decision', count: 1 }),
      ]),
    });
    expect(res.body.results[0]).toMatchObject({
      title: 'CAN Calibration Decision Log',
      reasons: expect.arrayContaining(['Title match', 'Body match', 'Status: Published', 'Recently updated']),
      snippet: expect.stringContaining('calibration'),
    });
  });

  it('matches the word still being typed as a prefix, so results appear before the word is finished', async () => {
    await createPage('Modbus Gateway Commissioning', 'Commission the field gateway and verify register maps.', { tags: ['fieldbus'] });

    const partial = await request(app.getHttpServer())
      .get('/api/v1/search?q=modb')
      .set('Cookie', cookie)
      .expect(200);
    expect(partial.body.results.map((r: { title: string }) => r.title)).toContain('Modbus Gateway Commissioning');

    // A quoted phrase is never prefix-expanded: the reader asked for that exact wording.
    const quoted = await request(app.getHttpServer())
      .get('/api/v1/search?q="modb"')
      .set('Cookie', cookie)
      .expect(200);
    expect(quoted.body.results).toEqual([]);
  });

  it('excludes terms and phrases the reader ruled out with a minus sign', async () => {
    await createPage('Excluded Compose Guide', 'Run the stack with docker compose up.', { tags: ['docker'] });
    await createPage('Excluded Build Guide', 'Build the image with docker build and push it.', { tags: ['docker'] });

    const excluded = await request(app.getHttpServer())
      .get('/api/v1/search?q=docker -compose')
      .set('Cookie', cookie)
      .expect(200);
    const titles = excluded.body.results.map((r: { title: string }) => r.title);
    expect(titles).toContain('Excluded Build Guide');
    expect(titles).not.toContain('Excluded Compose Guide');
    expect(excluded.body.warnings).toEqual([]);

    const phrase = await request(app.getHttpServer())
      .get('/api/v1/search?q=docker -"compose up"')
      .set('Cookie', cookie)
      .expect(200);
    expect(phrase.body.results.map((r: { title: string }) => r.title)).not.toContain('Excluded Compose Guide');
  });

  it('keeps every value of a repeated filter, from the query text and from the URL', async () => {
    await createPage('Repeated Filter Mqtt', 'Shared repeated body.', { tags: ['mqtt'] });
    await createPage('Repeated Filter Modbus', 'Shared repeated body.', { tags: ['modbus'] });
    await createPage('Repeated Filter Other', 'Shared repeated body.', { tags: ['other'] });

    const fromQuery = await request(app.getHttpServer())
      .get('/api/v1/search?q=tag:mqtt tag:modbus repeated')
      .set('Cookie', cookie)
      .expect(200);
    expect(fromQuery.body.results.map((r: { title: string }) => r.title).sort()).toEqual([
      'Repeated Filter Modbus',
      'Repeated Filter Mqtt',
    ]);
    expect(fromQuery.body.warnings).toEqual([]);

    const fromUrl = await request(app.getHttpServer())
      .get('/api/v1/search?q=repeated&tag=mqtt&tag=modbus')
      .set('Cookie', cookie)
      .expect(200);
    expect(fromUrl.body.results.map((r: { title: string }) => r.title).sort()).toEqual([
      'Repeated Filter Modbus',
      'Repeated Filter Mqtt',
    ]);
  });

  it('applies type: - the facet /search offers - instead of warning it away', async () => {
    await createPage('Typed Runbook Item', 'Type filter body.', { frontmatter: { type: 'Runbook' } });
    await createPage('Typed Faq Item', 'Type filter body.', { frontmatter: { type: 'FAQ' } });

    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=type:runbook type filter')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.warnings).toEqual([]);
    expect(res.body.results.map((r: { title: string }) => r.title)).toEqual(['Typed Runbook Item']);

    const negated = await request(app.getHttpServer())
      .get('/api/v1/search?q=-type:Runbook type filter')
      .set('Cookie', cookie)
      .expect(200);
    expect(negated.body.results.map((r: { title: string }) => r.title)).toEqual(['Typed Faq Item']);

    const fromUrl = await request(app.getHttpServer())
      .get('/api/v1/search?q=type filter&type=FAQ')
      .set('Cookie', cookie)
      .expect(200);
    expect(fromUrl.body.results.map((r: { title: string }) => r.title)).toEqual(['Typed Faq Item']);
  });

  it('counts every match rather than the size of the page it returned', async () => {
    for (let i = 0; i < 7; i += 1) {
      await createPage(`Countable Item ${i}`, 'countableterm body text.', { tags: ['countable'] });
    }

    const firstPage = await request(app.getHttpServer())
      .get('/api/v1/search?q=countableterm&limit=3')
      .set('Cookie', cookie)
      .expect(200);
    expect(firstPage.body.results).toHaveLength(3);
    expect(firstPage.body.total).toBe(7);
    expect(firstPage.body.offset).toBe(0);
    expect(firstPage.body.limit).toBe(3);

    const secondPage = await request(app.getHttpServer())
      .get('/api/v1/search?q=countableterm&limit=3&offset=3')
      .set('Cookie', cookie)
      .expect(200);
    expect(secondPage.body.total).toBe(7);
    expect(secondPage.body.results.map((r: { id: string }) => r.id)).not.toEqual(
      firstPage.body.results.map((r: { id: string }) => r.id),
    );
  });

  it('counts facets over every match, not over the page - including content type and curated category', async () => {
    for (let i = 0; i < 5; i += 1) {
      await createPage(`Faceted Runbook ${i}`, 'facetedterm body text.', {
        tags: ['faceted'],
        frontmatter: { type: 'Runbook', categories: ['operations'], topic: 'Faceted Topic' },
      });
    }
    await createPage('Faceted Faq', 'facetedterm body text.', {
      tags: ['faceted'],
      frontmatter: { type: 'FAQ', categories: ['access'], topic: 'Faceted Topic' },
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=facetedterm&limit=2')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.results).toHaveLength(2);
    expect(res.body.total).toBe(6);
    expect(res.body.facets.types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'runbook', label: 'Runbook', count: 5 }),
        expect.objectContaining({ value: 'faq', label: 'FAQ', count: 1 }),
      ]),
    );
    expect(res.body.facets.categories).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 'operations', count: 5 })]),
    );
    expect(res.body.facets.topics).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Faceted Topic', count: 6 })]),
    );
    expect(res.body.facets.tags).toEqual(expect.arrayContaining([expect.objectContaining({ value: 'faceted', count: 6 })]));
  });

  it('counts a facet with the other filters applied but not its own, so a narrowed search still shows the way back', async () => {
    await createPage('Drilldown Runbook', 'drilldownterm body.', { frontmatter: { type: 'Runbook' } });
    await createPage('Drilldown Faq', 'drilldownterm body.', { frontmatter: { type: 'FAQ' } });

    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=drilldownterm&type=Runbook')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.results.map((r: { title: string }) => r.title)).toEqual(['Drilldown Runbook']);
    expect(res.body.total).toBe(1);
    // The FAQ chip is still on the page, with its honest count, or the reader
    // has narrowed into a corner with no visible way out.
    expect(res.body.facets.types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'runbook', count: 1, active: true }),
        expect.objectContaining({ value: 'faq', count: 1 }),
      ]),
    );
  });

  it('marks the active facet when the caller filtered by it', async () => {
    await createPage('Active Facet Item', 'activefacetterm body.', { tags: ['activefacet'], frontmatter: { type: 'Runbook' } });

    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=activefacetterm&type=Runbook&tag=activefacet')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.facets.types[0]).toMatchObject({ value: 'runbook', active: true });
    expect(res.body.facets.tags[0]).toMatchObject({ value: 'activefacet', active: true });
  });

  it('explains empty search recovery states', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/search?q=nonexistent-silicon-errata&tag=fpga')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.results).toEqual([]);
    // Every facet axis is present and empty — including the content type and
    // primary category axes /search filters on (reader UX plan §5.5).
    expect(res.body.facets).toEqual({ topics: [], statuses: [], tags: [], types: [], categories: [], trust_tiers: [] });
    expect(res.body.empty_state).toMatchObject({
      title: 'No matches for “nonexistent-silicon-errata”',
      can_create_from_search: true,
      guidance: expect.arrayContaining([
        expect.stringContaining('Relax these filters'),
        expect.stringContaining('titles, aliases, descriptions, body text, tags, categories, groups, Topic, status filters'),
      ]),
    });
  });
});
