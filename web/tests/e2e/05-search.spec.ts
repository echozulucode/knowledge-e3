/**
 * Maps to features/05-search.feature
 *
 * Both UI (page list search box) and API (recency-weighted ranker behaviour
 * which is hard to drive purely through the UI).
 */
import { test, expect, createPageViaApi, createUserApiContext } from './fixtures.js';
import playwright from '@playwright/test';

test.describe('search — UI', () => {
  test.skip('typing in the search box surfaces matching pages', async () => {
    // The redesigned PageList (header with filter pills + sort dropdown +
    // "+ New page" button) no longer includes an inline search input. Search
    // remains exercised at the API layer in the suite below; the UI surface
    // will get a new test once a search affordance is reintroduced (an
    // omnibar or `/` shortcut, per the open UI roadmap).
  });
});

test.describe('search — API and ranker behaviour', () => {
  test('recency multiplies, does not grant entry', async ({ apiAsAdmin }) => {
    // Seed a fresh page that does NOT match.
    await createPageViaApi(apiAsAdmin, {
      title: 'Fresh But Off-Topic',
      body: 'this page is about cats and gardening',
      status: 'published',
    });
    // Seed a matching page (will be older only by virtue of insertion order;
    // for a strict recency test the server tests use updated_at backdating).
    await createPageViaApi(apiAsAdmin, {
      title: 'On-Topic Doc',
      body: 'how retries work in payments',
      status: 'published',
    });
    const res = await apiAsAdmin.get('/api/v1/search?q=retries');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const titles = (body.results as { title: string }[]).map((r) => r.title);
    expect(titles).toContain('On-Topic Doc');
    expect(titles).not.toContain('Fresh But Off-Topic');
  });

  test("another user's drafts are excluded by default; admin can include them", async ({ apiAsAdmin }) => {
    // The visibility contract: a viewer sees published items plus their OWN
    // drafts; other people's drafts appear only with include_drafts (admin).
    // So the draft here is created by a SEPARATE user, not the admin searcher.
    const other = await createUserApiContext(playwright, apiAsAdmin, { username: 'drafter-05search' });
    await createPageViaApi(apiAsAdmin, { title: 'Pub Zebra', body: 'zebracorpus here', status: 'published' });
    await createPageViaApi(other, { title: 'Drf Zebra', body: 'zebracorpus here', status: 'draft' });
    await other.dispose();

    const def = await apiAsAdmin.get('/api/v1/search?q=zebracorpus');
    const defTitles = ((await def.json()).results as { title: string }[]).map((r) => r.title);
    expect(defTitles).toContain('Pub Zebra');
    expect(defTitles).not.toContain('Drf Zebra');

    const inc = await apiAsAdmin.get('/api/v1/search?q=zebracorpus&include_drafts=1');
    const incTitles = ((await inc.json()).results as { title: string }[]).map((r) => r.title).sort();
    expect(incTitles).toEqual(expect.arrayContaining(['Drf Zebra', 'Pub Zebra']));
  });

  test('tag filter narrows results', async ({ apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, { title: 'RA', body: 'tagnarrowcorpus', status: 'published', tags: ['runbook'] });
    await createPageViaApi(apiAsAdmin, { title: 'RefA', body: 'tagnarrowcorpus', status: 'published', tags: ['reference'] });
    const res = await apiAsAdmin.get('/api/v1/search?q=tagnarrowcorpus&tag=runbook');
    const body = await res.json();
    const titles = (body.results as { title: string }[]).map((r) => r.title);
    expect(titles).toContain('RA');
    expect(titles).not.toContain('RefA');
  });
});
