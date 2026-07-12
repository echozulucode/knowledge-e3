/**
 * Maps to features/05-search.feature
 *
 * Both UI (page list search box) and API (recency-weighted ranker behaviour
 * which is hard to drive purely through the UI).
 */
import { test, expect, createPageViaApi } from './fixtures.js';

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

  test('drafts are excluded by default; admin can include them', async ({ apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, { title: 'Pub Doc', body: 'retries here', status: 'published' });
    await createPageViaApi(apiAsAdmin, { title: 'Drf Doc', body: 'retries here', status: 'draft' });

    const def = await apiAsAdmin.get('/api/v1/search?q=retries');
    const defBody = await def.json();
    const defTitles = (defBody.results as { title: string }[]).map((r) => r.title);
    expect(defTitles).toContain('Pub Doc');
    expect(defTitles).not.toContain('Drf Doc');

    const inc = await apiAsAdmin.get('/api/v1/search?q=retries&include_drafts=1');
    const incBody = await inc.json();
    const incTitles = (incBody.results as { title: string }[]).map((r) => r.title).sort();
    expect(incTitles).toEqual(expect.arrayContaining(['Drf Doc', 'Pub Doc']));
  });

  test('tag filter narrows results', async ({ apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, { title: 'RA', body: 'retries', status: 'published', tags: ['runbook'] });
    await createPageViaApi(apiAsAdmin, { title: 'RefA', body: 'retries', status: 'published', tags: ['reference'] });
    const res = await apiAsAdmin.get('/api/v1/search?q=retries&tag=runbook');
    const body = await res.json();
    const titles = (body.results as { title: string }[]).map((r) => r.title);
    expect(titles).toContain('RA');
    expect(titles).not.toContain('RefA');
  });
});
