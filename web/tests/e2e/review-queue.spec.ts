import { test, expect, createPageViaApi } from './fixtures.js';
import type { Page } from '@playwright/test';

/**
 * Maps to features/13-sources-and-review.feature — the review-queue scenarios.
 *
 * A change request needs a `review`-mode source with a real remote and a real
 * host token, so the queue's populated state is staged at the two boundaries
 * the page consumes (`GET /admin/sources` and `GET /admin/sources/:id/reviews`),
 * the same way external-source.spec.ts stages a source onto a page read. The
 * empty state, which is the one a fresh instance actually shows, is real.
 *
 * Why this is worth a spec: under a review policy the queue is the ONLY place
 * an author can see that their item is parked behind someone else's approval.
 * If the grouping breaks, work disappears silently rather than loudly.
 */

const HOST = 'https://github.com/acme';

const SOURCES = [
  {
    id: 'topic:handbook',
    space_id: null,
    local_dir: 'topics/handbook',
    remote_url: `${HOST}/handbook.git`,
    branch: 'main',
    role: 'authoritative',
    mode: 'review',
    branch_prefix: 'e3/',
    host_kind: 'github',
    host_base_url: 'https://api.github.com',
    host_token_env: 'HANDBOOK_TOKEN',
    sync_every_seconds: 300,
    webhook_secret_env: null,
    default_status: 'draft',
    enabled: 1,
    last_synced_at: null,
    last_error: null,
    status: { state: 'idle', conflicts: 0 },
  },
  {
    id: 'topic:platform',
    space_id: null,
    local_dir: 'topics/platform',
    remote_url: `${HOST}/platform.git`,
    branch: 'main',
    role: 'authoritative',
    mode: 'review',
    branch_prefix: 'e3/',
    host_kind: 'github',
    host_base_url: 'https://api.github.com',
    host_token_env: 'PLATFORM_TOKEN',
    sync_every_seconds: 300,
    webhook_secret_env: null,
    default_status: 'draft',
    enabled: 1,
    last_synced_at: null,
    last_error: null,
    status: { state: 'idle', conflicts: 0 },
  },
];

const REVIEWS: Record<string, unknown[]> = {
  'topic:handbook': [
    {
      page_id: 'itm_handbook_1',
      slug: 'onboarding-checklist',
      title: 'Onboarding Checklist',
      state: 'open',
      url: `${HOST}/handbook/pull/12`,
      branch: 'e3/onboarding-checklist-a1b2c3',
      opened_at: '2026-09-10T09:00:00.000Z',
      closed_at: null,
      source_id: 'topic:handbook',
    },
  ],
  'topic:platform': [
    {
      page_id: 'itm_platform_1',
      slug: 'retry-budget',
      title: 'Retry Budget',
      state: 'open',
      url: `${HOST}/platform/pull/7`,
      branch: 'e3/retry-budget-d4e5f6',
      opened_at: '2026-09-09T09:00:00.000Z',
      closed_at: null,
      source_id: 'topic:platform',
    },
  ],
};

/** Serve the registry and each source's queue from the fixtures above. */
async function withReviewSources(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/v1/admin/sources',
    (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ sources: SOURCES }) }),
  );
  await page.route(
    (url) => /^\/api\/v1\/admin\/sources\/[^/]+\/reviews$/.test(url.pathname),
    (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[5] ?? '');
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ reviews: REVIEWS[id] ?? [] }),
      });
    },
  );
}

test.describe('the review queue', () => {
  test('groups every item in review under the source that opened its change request', async ({ signedInPage }) => {
    await withReviewSources(signedInPage);
    await signedInPage.goto('/review');

    await expect(signedInPage.getByRole('heading', { name: 'In review', exact: true })).toBeVisible();
    await expect(signedInPage.locator('.ReviewQueue__count')).toContainText('2 items in review', { timeout: 15_000 });

    const handbook = signedInPage.getByRole('region', { name: 'Reviews for topic:handbook' });
    await expect(handbook.getByRole('heading', { name: 'topic:handbook' })).toBeVisible();
    // Each group names where that source points.
    await expect(handbook).toContainText(`${HOST}/handbook.git`);
    await expect(handbook.getByRole('link', { name: 'Onboarding Checklist' })).toBeVisible();
    await expect(handbook).toContainText('e3/onboarding-checklist-a1b2c3');

    const platform = signedInPage.getByRole('region', { name: 'Reviews for topic:platform' });
    await expect(platform).toContainText(`${HOST}/platform.git`);
    await expect(platform.getByRole('link', { name: 'Retry Budget' })).toBeVisible();

    // The handbook item is not filed under the platform source, and vice versa.
    await expect(platform.getByRole('link', { name: 'Onboarding Checklist' })).toHaveCount(0);
  });

  test('says so when no source uses the review policy and points at Sources', async ({ signedInPage }) => {
    await signedInPage.goto('/review');

    await expect(signedInPage.locator('.ReviewQueue__count')).toContainText('0 items in review', { timeout: 15_000 });
    await expect(signedInPage.getByText(/no source uses the review policy yet/i)).toBeVisible();
    await expect(signedInPage.getByRole('link', { name: /admin → sources/i })).toHaveAttribute('href', '/admin/repos');
  });

  test('an item whose change request is open carries an In review badge on its read page', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    const title = `Parked In Review ${testInfo.workerIndex}-${Date.now()}`;
    const created = await createPageViaApi(apiAsAdmin, {
      title,
      body: 'Waiting on somebody else to merge it.',
      status: 'published',
      frontmatter: { type: 'concept', description: 'Sits behind a change request.' },
    });

    // Lifecycle signals are derived on /items/:id; the change request is the
    // one field on them a browser can never arrange.
    await signedInPage.route(
      (url) => url.pathname === `/api/v1/items/${created.id}`,
      async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        if (body.item) {
          body.item.review = {
            state: 'open',
            url: `${HOST}/handbook/pull/12`,
            branch: 'e3/parked-a1b2c3',
            opened_at: '2026-09-10T09:00:00.000Z',
            closed_at: null,
          };
        }
        await route.fulfill({ status: response.status(), contentType: 'application/json', body: JSON.stringify(body) });
      },
    );

    await signedInPage.goto(`/p/${created.slug}`);
    await expect(signedInPage.getByRole('heading', { level: 1, name: title })).toBeVisible({ timeout: 15_000 });

    const badge = signedInPage.locator('.kp-badge[data-tone="in-review"]');
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toContainText('In review');
    await expect(badge.getByRole('link')).toHaveAttribute('href', `${HOST}/handbook/pull/12`);
  });
});
