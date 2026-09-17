import { test, expect, createPageViaApi } from './fixtures.js';
import type { APIRequestContext } from '@playwright/test';

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
 * One item, one presentation (reader UX plan R1.3/R1.4).
 *
 * The indexes are allowed to differ in shape — a feed is a column of cards, a
 * topic landing is a list of rows — but not in facts. These assert that the two
 * shapes really are the shared `ItemCard`/`ItemRow` from `@echozedlabs/ui`, and
 * that the same item states the same thing about itself on both.
 */
async function appendSections(api: APIRequestContext, sections: Record<string, unknown>[]) {
  const current = await api.get('/api/v1/sections');
  if (!current.ok()) throw new Error(`list sections failed: ${current.status()}`);
  const existing = ((await current.json()).sections ?? []) as Record<string, unknown>[];
  const res = await api.put('/api/v1/sections', { data: { sections: [...existing, ...sections] } });
  if (!res.ok()) throw new Error(`save sections failed: ${res.status()} ${await res.text()}`);
}

test.describe('item presentation', () => {
  test('the same item reads the same way as a feed card and as a topic row', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const slug = `presentation-${suffix}`;
    const title = `Presented Item ${suffix}`;
    const lead = `The one lead sentence ${suffix}.`;

    const seed = await apiAsAdmin.post('/api/v1/topics', {
      data: { name: `Presentation Topic ${suffix}`, slug, description: 'Shared presentation.', presentation: 'wiki' },
    });
    if (!seed.ok()) throw new Error(`seed topic failed: ${seed.status()} ${await seed.text()}`);

    await createPageViaApi(apiAsAdmin, {
      title,
      body: 'Body prose that must never be used as the preview here.',
      status: 'published',
      frontmatter: { type: 'Blog Post', topic: slug, description: lead, authors: ['Ada Lovelace'], published_at: aheadOfEverything() },
    });
    await appendSections(apiAsAdmin, [
      { name: `Presented ${suffix}`, slug: `presented-${suffix}`, type: 'Blog Post', space: slug, order: 1 },
    ]);

    // The feed: the shared card, with the item's own lead and its byline.
    await signedInPage.goto('/latest');
    const card = signedInPage.locator('article.kp-item-card').filter({ hasText: title });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText(lead);
    await expect(card).toContainText('By Ada Lovelace');
    await expect(card.locator('.kp-item-badges')).toBeVisible();
    await expect(card.getByRole('link', { name: title })).toBeVisible();

    // The topic landing: the shared row — a different shape, the same facts.
    await signedInPage.goto(`/topics/${slug}`);
    // Scoped to the curated Section: the topic page's "Recently updated" block
    // (home plan R3.3) lists the same item above it, by design.
    const row = signedInPage.getByRole('region', { name: `Presented ${suffix}` }).locator('li.kp-item-row').filter({ hasText: title });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText(lead);
    await expect(row.locator('.kp-item-badges')).toBeVisible();

    // The row's title link covers the whole row, so clicking the row opens the
    // item — and it is the only link in the row, so it is unambiguous.
    await expect(row.getByRole('link')).toHaveCount(1);
    await row.click();
    await expect(signedInPage).toHaveURL(/\/p\//);
    await expect(signedInPage.getByRole('heading', { level: 1, name: title })).toBeVisible();
  });
});
