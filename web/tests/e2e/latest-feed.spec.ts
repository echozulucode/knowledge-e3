import { test, expect, createPageViaApi } from './fixtures.js';

/**
 * A publication date ahead of every other item in the instance. `/latest` is
 * newest-first with no filter, and the suite publishes dozens of items dated
 * "now" (plus the seeded corpus), so a fixture dated in the past falls off the
 * first page as soon as the instance grows — which is how these tests broke
 * when the seed gained a series. Offsets keep relative order where it matters.
 */
function aheadOfEverything(offsetMinutes = 0): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000 + offsetMinutes * 60 * 1000).toISOString();
}

/**
 * Latest feed and series (features/12-latest-feed.feature).
 *
 * The front page's own assertions live in home.spec.ts. They used to be here
 * because a topic's `presentation: portal` swapped the whole front page for the
 * Kickoff layout; it no longer does anything of the sort - there is one home
 * page and a bundle key cannot change its shape - so `defaultTopic` and the flip
 * that restored it afterwards went with that test.
 */
test.describe('latest feed', () => {
  test('lists a published Blog Post with its byline and series chip, and hides drafts', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const series = `getting-started-${suffix}`;
    const first = await createPageViaApi(apiAsAdmin, {
      title: `Feed Post One ${suffix}`,
      body: 'Part one of the series.',
      status: 'published',
      frontmatter: { type: 'Blog Post', authors: ['Ada Lovelace'], published_at: aheadOfEverything(0), series, series_order: 1, description: 'Step one' },
    });
    const second = await createPageViaApi(apiAsAdmin, {
      title: `Feed Post Two ${suffix}`,
      body: 'Part two of the series.',
      status: 'published',
      frontmatter: { type: 'Blog Post', authors: ['Grace Hopper'], published_at: aheadOfEverything(2), series, series_order: 2 },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `Feed Draft ${suffix}`,
      body: 'Unfinished.',
      status: 'draft',
      frontmatter: { type: 'Blog Post' },
    });

    await signedInPage.goto('/latest');
    await expect(signedInPage.getByRole('heading', { level: 1, name: 'Latest' })).toBeVisible();
    await expect(signedInPage.getByRole('link', { name: /atom feed/i })).toHaveAttribute('href', '/api/v1/feeds/latest.atom');

    const card = signedInPage.getByTestId('feed-card').filter({ hasText: `Feed Post One ${suffix}` });
    await expect(card).toBeVisible();
    await expect(card).toContainText('By Ada Lovelace');
    await expect(card).toContainText('min read');
    await expect(card).toContainText(String(new Date(aheadOfEverything()).getFullYear()));
    await expect(card).toContainText('Step one');
    await expect(signedInPage.getByText(`Feed Draft ${suffix}`)).toHaveCount(0);

    await card.getByRole('link', { name: new RegExp(`Series: ${series}`) }).click();
    await expect(signedInPage).toHaveURL(new RegExp(`/series/${series}$`));
    // The series page lists its parts as plain rows in `series_order`. Previous
    // and next moved INTO the article (home plan R2.11) — the reader who
    // finished part 1 wants part 2, not the index — and series.spec.ts owns
    // those assertions; this one only checks the chip lands on the right list.
    const parts = signedInPage.locator('[data-testid="series-part"]');
    await expect(parts).toHaveCount(2);
    await expect(parts.nth(0)).toContainText(`Feed Post One ${suffix}`);
    await expect(parts.nth(1)).toContainText(`Feed Post Two ${suffix}`);
    await expect(parts.nth(0).getByRole('link', { name: `Feed Post One ${suffix}` })).toHaveAttribute('href', `/p/${first.slug}`);
    await expect(parts.nth(1).getByRole('link', { name: `Feed Post Two ${suffix}` })).toHaveAttribute('href', `/p/${second.slug}`);
  });

  test('a Latest card says nothing about an unverified trust tier', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    await createPageViaApi(apiAsAdmin, {
      title: `Quiet Trust Post ${suffix}`,
      body: 'Nobody has reviewed this.',
      status: 'published',
      frontmatter: { type: 'Blog Post', published_at: aheadOfEverything(4) },
    });

    await signedInPage.goto('/latest');
    const card = signedInPage.getByTestId('feed-card').filter({ hasText: `Quiet Trust Post ${suffix}` });
    await expect(card).toBeVisible({ timeout: 15_000 });
    // An index surface (home plan R2.4): absence is not a claim, and a warning
    // repeated on every card trains readers to ignore it. The article page is
    // where the tier is stated in words.
    await expect(card.getByText('Unverified')).toHaveCount(0);
    await expect(card.locator('.kp-trust-mark')).toHaveCount(0);
    await expect(card.locator('.kp-trust .kp-badge')).toHaveCount(0);
  });
});
