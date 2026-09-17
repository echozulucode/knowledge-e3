import { test, expect, createPageViaApi } from './fixtures.js';
import type { APIRequestContext } from '@playwright/test';

/**
 * Topic landing pages (features/11-topic-landing.feature): a portal topic
 * renders a populated Section slot and hides an empty one; the topics index
 * lists the topic; a missing topic is a 404 state.
 *
 * Sections are a whole-catalog PUT, so the spec appends to whatever is there
 * instead of replacing it.
 */
async function appendSections(api: APIRequestContext, sections: Record<string, unknown>[]) {
  const current = await api.get('/api/v1/sections');
  if (!current.ok()) throw new Error(`list sections failed: ${current.status()}`);
  const existing = ((await current.json()).sections ?? []) as Record<string, unknown>[];
  const res = await api.put('/api/v1/sections', { data: { sections: [...existing, ...sections] } });
  if (!res.ok()) throw new Error(`save sections failed: ${res.status()} ${await res.text()}`);
}

test.describe('topic landing pages', () => {
  test('a portal topic renders its essential slot, hides an empty one, and offers Get started', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const slug = `portal-${suffix}`;
    const name = `Portal Topic ${suffix}`;
    const seed = await apiAsAdmin.post('/api/v1/topics', {
      data: { name, slug, description: 'Use AI to understand models.', presentation: 'portal', landing_markdown: `Gateway prose ${suffix}.` },
    });
    if (!seed.ok()) throw new Error(`seed topic failed: ${seed.status()} ${await seed.text()}`);

    const start = await createPageViaApi(apiAsAdmin, {
      title: `Start With AI ${suffix}`,
      body: 'Start here.',
      status: 'published',
      frontmatter: { type: 'how-to', topic: slug },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `Essential Guide ${suffix}`,
      body: 'Essential.',
      status: 'published',
      frontmatter: { type: 'how-to', topic: slug, description: 'Recommended workflow.' },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `Draft Guide ${suffix}`,
      body: 'Not yet.',
      status: 'draft',
      frontmatter: { type: 'how-to', topic: slug },
    });
    const topicId = (await seed.json()).topic.id as string;
    const put = await apiAsAdmin.put(`/api/v1/topics/${topicId}`, { data: { start_here: start.slug } });
    if (!put.ok()) throw new Error(`set start_here failed: ${put.status()}`);

    await appendSections(apiAsAdmin, [
      { name: `Essential ${suffix}`, slug: `essential-${suffix}`, type: 'how-to', space: slug, slot: 'essential', order: 1 },
      { name: `Limitations ${suffix}`, slug: `limitations-${suffix}`, type: 'known-issue', space: slug, slot: 'limitations', order: 2 },
    ]);

    await signedInPage.goto(`/topics/${slug}`);
    const main = signedInPage.locator('main.TopicLanding');
    await expect(main).toHaveAttribute('data-presentation', 'portal');
    await expect(signedInPage.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(signedInPage.getByText(`Gateway prose ${suffix}.`)).toBeVisible();

    const essential = main.locator('.TopicLanding__section[data-slot="essential"]');
    await expect(essential.getByRole('heading', { name: 'Essential guidance' })).toBeVisible();
    await expect(essential.getByRole('link', { name: `Essential Guide ${suffix}` })).toBeVisible();
    await expect(essential.getByText('Recommended workflow.')).toBeVisible();
    await expect(essential.getByRole('link', { name: `Draft Guide ${suffix}` })).toHaveCount(0);

    // The limitations Section resolves to nothing, so its slot is not rendered.
    await expect(main.locator('.TopicLanding__section[data-slot="limitations"]')).toHaveCount(0);
    await expect(signedInPage.getByRole('heading', { name: 'Known limitations' })).toHaveCount(0);

    await signedInPage.getByRole('link', { name: /get started/i }).click();
    await expect(signedInPage).toHaveURL(new RegExp(`/p/${start.slug}$`));
  });

  test('the topics index lists the topic with its presentation and links to the landing page', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const slug = `index-${suffix}`;
    const name = `Index Topic ${suffix}`;
    const seed = await apiAsAdmin.post('/api/v1/topics', { data: { name, slug, description: 'Listed on the index.', presentation: 'docs' } });
    if (!seed.ok()) throw new Error(`seed topic failed: ${seed.status()}`);

    await signedInPage.goto('/topics');
    const tile = signedInPage.getByRole('listitem').filter({ hasText: name });
    await expect(tile).toBeVisible();
    await expect(tile).toContainText('Listed on the index.');
    await expect(tile).toContainText('0 items');
    await expect(tile.locator('.TopicsIndex__chip')).toHaveText('docs');
    await tile.click();
    await expect(signedInPage).toHaveURL(new RegExp(`/topics/${slug}$`));
    await expect(signedInPage.locator('main.TopicLanding')).toHaveAttribute('data-presentation', 'docs');
  });

  test('a missing topic shows the not-found state', async ({ signedInPage }) => {
    await signedInPage.goto('/topics/does-not-exist-anywhere');
    await expect(signedInPage.getByRole('heading', { level: 1, name: 'Topic not found' })).toBeVisible();
    await expect(signedInPage.getByRole('link', { name: 'All topics' })).toBeVisible();
  });
});
