/**
 * Maps to features/10-grouped-search.feature.
 *
 * `/search` before anything is typed, and search narrowed to one topic
 * (reader UX plan §5.6 R3.5, §5.7 R3.6 / reader plan R12):
 *
 *  - With no query and no filters the page is an index of the library, from
 *    `GET /search/overview`: a total, "Browse by type", "Topics", "Categories",
 *    "Popular tags", "Recently verified" and "Recently updated".
 *  - A topic landing has a "Search in <topic>" box that submits to
 *    `/search?q=…&topic=<slug>`; an article's topic line has a "Search in
 *    <topic>" link to `/search?topic=<slug>` (no query: the topic's items,
 *    newest first).
 *  - A topic filter is a scope, named as a removable chip "In <topic>" at the
 *    top of the results. It survives a new query; removing it widens the same
 *    query to every topic.
 *  - `/help` has a "Searching" section: the query syntax table (generated from
 *    the parser's supported keys), the rules, and the vocabulary.
 *
 * Selectors the surface exposes:
 *   - region "The library at a glance" (data-testid search-overview) holding
 *     regions "Browse by type", "Topics", "Categories", "Popular tags",
 *     "Recently verified", "Recently updated"
 *   - search form "Search in <topic>" with textbox "Search in <topic>" (topic landing)
 *   - link "Search in <topic>" in the article's topic line
 *   - [data-testid=search-scope] with button "Remove scope: in <topic>. Search all topics"
 *   - combobox "Sort results"
 */
import { test, expect, createPageViaApi } from './fixtures.js';
import type { APIRequestContext, Page } from '@playwright/test';

function rows(page: Page) {
  return page.locator('.Search__row');
}

/**
 * One topic with two items and one item outside it, all sharing a nonsense
 * marker so the corpus a test sees is exactly what it seeded. The bodies make
 * `<marker> alpha` match one item inside the topic and one outside.
 */
async function seedScopedCorpus(api: APIRequestContext, suffix: string) {
  const marker = `scopemark${suffix.replace(/[^a-z0-9]/gi, '')}`;
  const slug = `scope-topic-${suffix}`;
  const name = `Scope Topic ${suffix}`;
  const seed = await api.post('/api/v1/topics', { data: { name, slug, description: 'Search scope fixture.', presentation: 'wiki' } });
  if (!seed.ok()) throw new Error(`seed topic failed: ${seed.status()} ${await seed.text()}`);

  const inside = await createPageViaApi(api, {
    title: `Scoped Alpha ${marker}`,
    body: `${marker} alpha inside the topic`,
    status: 'published',
    frontmatter: { type: 'Runbook', topic: slug },
  });
  await createPageViaApi(api, {
    title: `Scoped Beta ${marker}`,
    body: `${marker} beta inside the topic`,
    status: 'published',
    frontmatter: { type: 'Runbook', topic: slug },
  });
  await createPageViaApi(api, {
    title: `Unscoped Alpha ${marker}`,
    body: `${marker} alpha somewhere else`,
    status: 'published',
    frontmatter: { type: 'Runbook' },
  });
  return { marker, slug, name, inside };
}

test.describe('search with nothing typed', () => {
  test('the page is an index of types, topics, tags and recent items', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `overview${testInfo.workerIndex}x${Date.now()}`;
    await createPageViaApi(apiAsAdmin, {
      title: `Overview Fixture ${marker}`,
      body: `${marker} body`,
      status: 'published',
      tags: ['overview-fixture'],
      frontmatter: { type: 'Runbook' },
    });

    await signedInPage.goto('/search');
    const index = signedInPage.getByRole('region', { name: 'The library at a glance' });
    await expect(index).toBeVisible({ timeout: 15_000 });
    await expect(index).toContainText(/\d+ items? you can read/);

    // Every door is a ready-made /search URL.
    const types = index.getByRole('region', { name: 'Browse by type' });
    const typeLinks = types.getByRole('link');
    await expect(typeLinks.first()).toBeVisible();
    expect(new URL((await typeLinks.first().getAttribute('href'))!, 'http://x').searchParams.has('type')).toBe(true);

    const topics = index.getByRole('region', { name: 'Topics' });
    await expect(topics.locator('a[href*="/search?"]').first()).toBeVisible();
    expect(new URL((await topics.locator('a[href*="/search?"]').first().getAttribute('href'))!, 'http://x').searchParams.has('topic')).toBe(true);

    const tags = index.getByRole('region', { name: 'Popular tags' });
    await expect(tags.getByRole('link').first()).toBeVisible();
    expect(new URL((await tags.getByRole('link').first().getAttribute('href'))!, 'http://x').searchParams.has('tag')).toBe(true);
    // One size for every tag: the count carries the weight, not the type size.
    const sizes = await tags.locator('.Search__indexChip').evaluateAll((chips) => [...new Set(chips.map((chip) => getComputedStyle(chip).fontSize))]);
    expect(sizes).toHaveLength(1);

    // Just published, so there is at least one recently updated item, with its date.
    const updated = index.getByRole('region', { name: 'Recently updated' });
    await expect(updated.locator('.kp-item-row').first()).toBeVisible();
    await expect(updated.locator('.kp-item-row__meta').first()).toContainText(/Updated \S/);

    // A type chip is a search: results, newest first, with no claim to relevance.
    await typeLinks.first().click();
    await expect(signedInPage).toHaveURL((url) => url.pathname === '/search' && url.searchParams.has('type') && !url.searchParams.has('q'));
    await expect(rows(signedInPage).first()).toBeVisible({ timeout: 15_000 });
    const sort = signedInPage.getByRole('combobox', { name: 'Sort results' });
    await expect(sort).toHaveValue('newest');
    await expect(sort.locator('option', { hasText: 'Relevance' })).toHaveCount(0);
    await expect(sort.locator('option', { hasText: 'Recently verified' })).toHaveCount(1);
  });

  test.describe('on a small phone', () => {
    test.use({ viewport: { width: 360, height: 780 } });

    test('the index stacks to one column and nothing scrolls sideways', async ({ signedInPage }) => {
      await signedInPage.goto('/search');
      const index = signedInPage.getByRole('region', { name: 'The library at a glance' });
      await expect(index).toBeVisible({ timeout: 15_000 });
      const overflow = await signedInPage.evaluate(() => {
        const main = document.querySelector<HTMLElement>('.Search');
        return { doc: document.documentElement.scrollWidth - window.innerWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
      });
      expect(overflow.doc).toBeLessThanOrEqual(0);
      expect(overflow.main).toBeLessThanOrEqual(0);
    });
  });
});

test.describe('search scoped to a topic', () => {
  test('the topic landing box searches in the topic; the scope chip survives a new query and widens when removed', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const { marker, slug, name } = await seedScopedCorpus(apiAsAdmin, `${testInfo.workerIndex}-${Date.now()}`);

    await signedInPage.goto(`/topics/${slug}`);
    const box = signedInPage.getByRole('search', { name: `Search in ${name}` }).getByRole('textbox', { name: `Search in ${name}` });
    await expect(box).toBeVisible({ timeout: 15_000 });
    await box.fill(marker);
    await box.press('Enter');

    await expect(signedInPage).toHaveURL((url) => url.pathname === '/search' && url.searchParams.get('q') === marker && url.searchParams.get('topic') === slug);
    const scope = signedInPage.getByTestId('search-scope');
    const chip = scope.getByRole('button', { name: `Remove scope: in ${name}. Search all topics` });
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText(`In ${name}`);
    await expect(rows(signedInPage)).toHaveCount(2, { timeout: 15_000 });
    await expect(rows(signedInPage).filter({ hasText: `Unscoped Alpha ${marker}` })).toHaveCount(0);

    // A new query keeps the scope: it was chosen, and it is on screen.
    await signedInPage.locator('[data-search-input]').fill(`${marker} alpha`);
    await expect(signedInPage).toHaveURL((url) => url.searchParams.get('q') === `${marker} alpha` && url.searchParams.get('topic') === slug, { timeout: 15_000 });
    await expect(rows(signedInPage)).toHaveCount(1, { timeout: 15_000 });
    await expect(rows(signedInPage).first()).toContainText(`Scoped Alpha ${marker}`);

    // Removing the scope widens the same query to every topic.
    await chip.click();
    await expect(signedInPage).toHaveURL((url) => !url.searchParams.has('topic') && url.searchParams.get('q') === `${marker} alpha`);
    await expect(scope).toHaveCount(0);
    await expect(rows(signedInPage)).toHaveCount(2, { timeout: 15_000 });
    await expect(rows(signedInPage).filter({ hasText: `Unscoped Alpha ${marker}` })).toHaveCount(1);
    await expect(signedInPage.locator('[data-search-input]')).toBeFocused();
  });

  test("an article's topic line opens the topic's items on /search, newest first", async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const { marker, slug, name, inside } = await seedScopedCorpus(apiAsAdmin, `${testInfo.workerIndex}-${Date.now()}`);

    await signedInPage.goto(`/p/${inside.slug}`);
    const link = signedInPage.getByRole('link', { name: `Search in ${name}` });
    await expect(link).toBeVisible({ timeout: 15_000 });
    await link.click();

    await expect(signedInPage).toHaveURL((url) => url.pathname === '/search' && url.searchParams.get('topic') === slug && !url.searchParams.has('q'));
    // A filter alone is a search, not the no-query index.
    await expect(signedInPage.getByRole('region', { name: 'The library at a glance' })).toHaveCount(0);
    await expect(signedInPage.getByTestId('search-scope')).toContainText(`In ${name}`, { timeout: 15_000 });
    await expect(rows(signedInPage).filter({ hasText: marker })).toHaveCount(2, { timeout: 15_000 });
    await expect(rows(signedInPage).filter({ hasText: `Unscoped Alpha ${marker}` })).toHaveCount(0);
    // Nothing to rank against, so the page says what order it is in.
    await expect(signedInPage.getByRole('combobox', { name: 'Sort results' })).toHaveValue('newest');
  });
});

test.describe('search help', () => {
  test('/help explains the query syntax from the supported filters, and the vocabulary', async ({ signedInPage }) => {
    await signedInPage.goto('/help');
    const section = signedInPage.getByRole('region', { name: 'Searching' });
    await expect(section.getByRole('heading', { level: 2, name: 'Searching' })).toBeVisible({ timeout: 15_000 });

    const syntax = section.getByRole('region', { name: 'Query syntax' }).getByRole('table');
    await expect(syntax.getByRole('columnheader')).toHaveText(['Filter', 'Meaning', 'Example']);
    for (const key of ['tag:', 'category:', 'topic:', 'type:', 'author:', 'updated:', 'is:', 'status:']) {
      await expect(syntax.getByRole('rowheader', { name: key, exact: true })).toBeVisible();
    }
    await expect(syntax.getByRole('row').filter({ has: signedInPage.getByRole('rowheader', { name: 'updated:', exact: true }) })).toContainText('updated:>2026-01-01');

    // The rules: phrases, exclusion, prefixes, and the forms updated: takes.
    await expect(section).toContainText('"pod disruption budget"');
    await expect(section).toContainText('docker -compose');
    await expect(section).toContainText(/prefix/);
    await expect(section).toContainText(/updated:30d/);

    const vocabulary = section.getByRole('region', { name: 'What the filters mean' }).getByRole('table');
    for (const term of ['Topic', 'Type', 'Category', 'Tag', 'Trust tier']) {
      await expect(vocabulary.getByRole('rowheader', { name: term, exact: true })).toBeVisible();
    }
    await expect(section).not.toContainText(/\bAI\b|semantic|fuzzy/i);
  });
});
