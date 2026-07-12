/**
 * Maps to features/07-audit-and-telemetry.feature scenario:
 *   "Page-view telemetry is captured client-side"
 *
 * Server-side persistence is tested in server/tests/telemetry.e2e.test.ts.
 * Here we drive a real browser and assert the client actually fires the
 * /events/page-view request when a user lands on /p/<slug>.
 */
import { test, expect, createPageViaApi } from './fixtures.js';

test.describe('telemetry — UI', () => {
  test('client POSTs /events/page-view when visiting /p/<slug>', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Telemetry Page',
      body: 'just here for the page view',
      status: 'published',
    });

    const requestPromise = signedInPage.waitForRequest(
      (req) => req.method() === 'POST' && req.url().includes('/api/v1/events/page-view'),
      { timeout: 15_000 },
    );
    await signedInPage.goto(`/p/${p.slug}`);
    const req = await requestPromise;

    const body = req.postDataJSON() as { page_id?: string };
    expect(body.page_id).toBe(p.id);
  });
});
