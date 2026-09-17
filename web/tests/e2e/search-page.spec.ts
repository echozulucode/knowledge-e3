/**
 * Maps to features/10-grouped-search.feature.
 *
 * `/search` (plan §3.5 item 1) — the full-page twin of the ⌘K palette. It
 * renders the SAME server-computed groups; what it adds is a room: a query that
 * lives in the URL, Back and Forward, facets that narrow, and — since Browse and
 * Tags left the sidebar (§3.4) — the doors to both.
 *
 * The page is a size container (2026-09-12 redesign): at >= 64rem of page
 * width the facets are a sticky sidebar beside results that fill the rest of
 * the 80rem page cap (`--kp-page-width`, 2026-09-13; at most 61rem); between
 * 40 and 64rem they are chip rows above results; below 40rem a "Filters (n)"
 * button opens them in a modal dialog and active filters are removable chips.
 *
 * Selectors the surface exposes:
 *   - main "Search" with heading "Search" and role=search form
 *   - input [data-search-input] / aria-label "Search knowledge"
 *   - nav "Other ways into the library" (below results) with links Browse all
 *     items, Browse by tag, Topics, Sections
 *   - complementary "Filters" (wide + medium) holding .Search__facet toggles:
 *     "All types" + one per content-type group, each aria-pressed
 *   - button "Filters" / "Filters (n)" and dialog "Filters" (narrow)
 *   - button "Remove <Axis> filter <value>" per active filter (narrow)
 *   - section "<Type> results" with an h2 and a "See all N" link that narrows /search to the type
 *   - "Show N more" / "Show fewer" (aria-expanded) closing a facet group with
 *     more than six options; an active option is never folded away
 *   - .Search__row (a link to /p/:slug) holding the shared row: title,
 *     snippet, and one .kp-item-meta line `Topic · Type · Updated <date>`,
 *     with a chip only for a state worth a word (Draft, Needs review, …)
 *   - .Search__empty when the query matched nothing
 *   - <mark> inside .kp-result-row__title / .kp-result-row__snippet where the
 *     server's `highlights` ranges say the query matched
 *   - combobox "Sort results": Relevance (with a query), Newest, Oldest, A–Z,
 *     Recently verified
 *   - group "Trust" (facet `is=`) and, for a reader who can see drafts, "Status"
 *
 * With no query and no filters the page is the library index — covered, with
 * topic scope, by search-overview-scope.spec.ts.
 */
import { test, expect, createPageViaApi } from './fixtures.js';
import type { Page } from '@playwright/test';

function rowFor(page: Page, title: string) {
  return page.locator('.Search__row').filter({ hasText: title });
}

function facet(page: Page, label: string) {
  return page.locator('.Search__facet').filter({ hasText: new RegExp(`^${label}`) });
}

/**
 * Two items whose tags make one facet group longer than the six it shows:
 * tags a–f are on both (count 2), g and h only on the first (count 1). So the
 * top six by count are a–f, and g and h fold behind "Show 2 more".
 */
async function seedManyTags(api: import('@playwright/test').APIRequestContext, marker: string) {
  const tag = (letter: string) => `${marker}-${letter}`;
  await createPageViaApi(api, {
    title: `Tagged Widely ${marker}`,
    body: `${marker} carries every tag`,
    status: 'published',
    tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(tag),
    frontmatter: { type: 'Concept' },
  });
  await createPageViaApi(api, {
    title: `Tagged Narrowly ${marker}`,
    body: `${marker} carries six tags`,
    status: 'published',
    tags: ['a', 'b', 'c', 'd', 'e', 'f'].map(tag),
    frontmatter: { type: 'Concept' },
  });
  return tag;
}

/** One tag option in a facet group: its label, then straight into its count. */
function tagOption(group: import('@playwright/test').Locator, label: string) {
  return group.locator('.Search__facet').filter({ hasText: new RegExp(`^${label}\\d`) });
}

/**
 * Three typed items sharing one nonsense marker, so the search corpus this test
 * sees is exactly what it seeded — the e2e DB carries a 100-item seed corpus.
 */
async function seedTypedCorpus(api: import('@playwright/test').APIRequestContext, marker: string) {
  await createPageViaApi(api, {
    title: `Search Page Runbook A ${marker}`,
    body: `${marker} rotate the signing keys`,
    status: 'published',
    frontmatter: { type: 'Runbook' },
  });
  await createPageViaApi(api, {
    title: `Search Page Runbook B ${marker}`,
    body: `${marker} restart the worker pool`,
    status: 'published',
    frontmatter: { type: 'Runbook' },
  });
  return createPageViaApi(api, {
    title: `Search Page FAQ ${marker}`,
    body: `${marker} why does it retry`,
    status: 'published',
    frontmatter: { type: 'FAQ' },
  });
}

test.describe('the search page', () => {
  test('a query in the URL renders the server groups and a row opens the item', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `searchpage-${testInfo.workerIndex}-${Date.now()}`;
    const faq = await seedTypedCorpus(apiAsAdmin, marker);

    await signedInPage.goto(`/search?q=${marker}`);

    // The query the URL carries is the query the box shows: a shared link opens
    // on the results, not on an empty box.
    await expect(signedInPage.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
    await expect(signedInPage.locator('[data-search-input]')).toHaveValue(marker);

    const runbooks = signedInPage.getByRole('region', { name: 'Runbook results' });
    const faqs = signedInPage.getByRole('region', { name: 'FAQ results' });
    await expect(runbooks).toBeVisible({ timeout: 15_000 });
    await expect(faqs).toBeVisible();
    await expect(runbooks.getByRole('heading', { level: 2, name: 'Runbook' })).toBeVisible();
    await expect(runbooks.locator('.Search__row')).toHaveCount(2);
    await expect(faqs.locator('.Search__row')).toHaveCount(1);
    await expect(signedInPage.getByRole('status')).toContainText(`3 results for ‘${marker}’`);

    // A plain published, unverified result is title, snippet and one quiet
    // line — topic · type · Updated <date> — with no chip of any kind (home plan
    // R2.4). The type is text because the group heading already names it;
    // "Published", "Title match"/"Body match" and "Recently updated" said
    // nothing the snippet and the date do not.
    const faqRow = rowFor(signedInPage, `Search Page FAQ ${marker}`);
    await expect(faqRow.locator('.kp-result-row__meta .kp-item-meta__part')).toHaveText([/^[^·]+$/, /^·\s*FAQ$/, /^·\s*Updated \S/]);
    await expect(faqRow.locator('.kp-type-badge')).toHaveCount(0);
    await expect(faqRow.locator('.kp-badge')).toHaveCount(0);
    await expect(faqRow.locator('.kp-trust-mark')).toHaveCount(0);
    for (const chip of ['Published', 'Unverified', 'Title match', 'Body match', 'Recently updated']) {
      await expect(faqRow.getByText(chip, { exact: true })).toHaveCount(0);
    }
    // Why it matched survives only as data, for tooling — never as text.
    await expect(faqRow.locator('.kp-result-row')).toHaveAttribute('data-match', /\bbody\b/);

    // Each group's "See all" narrows this same page to the type, keeping the
    // query — one results destination, not a hand-off to Browse (home plan R2.3).
    const seeAll = runbooks.getByRole('link', { name: /see all 2/i });
    await expect(seeAll).toBeVisible();
    const seeAllUrl = new URL((await seeAll.getAttribute('href'))!, 'http://x');
    expect(seeAllUrl.pathname).toBe('/search');
    expect(seeAllUrl.searchParams.get('q')).toBe(marker);
    expect(seeAllUrl.searchParams.getAll('type')).toEqual(['Runbook']);

    // A row is a link to the item, so it opens in place and Back returns here.
    await rowFor(signedInPage, `Search Page FAQ ${marker}`).click();
    await expect(signedInPage).toHaveURL((url) => url.pathname === `/p/${faq.slug}`, { timeout: 15_000 });

    await signedInPage.goBack();
    await expect(signedInPage).toHaveURL((url) => url.pathname === '/search' && url.searchParams.get('q') === marker);
    await expect(signedInPage.locator('[data-search-input]')).toHaveValue(marker);
    await expect(rowFor(signedInPage, `Search Page FAQ ${marker}`)).toBeVisible({ timeout: 15_000 });

    await signedInPage.goForward();
    await expect(signedInPage).toHaveURL((url) => url.pathname === `/p/${faq.slug}`);
  });

  test('refining the query costs one history entry, not one per keystroke', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `searchrefine-${testInfo.workerIndex}-${Date.now()}`;
    await createPageViaApi(apiAsAdmin, {
      title: `Search Refine Target ${marker}`,
      body: `${marker} the only match`,
      status: 'published',
      frontmatter: { type: 'Concept' },
    });

    // Arrive from Home, so there is a previous entry to go Back to.
    await signedInPage.goto('/');
    await signedInPage.goto('/search');
    // The no-query index (or its one-line fallback while the overview loads).
    await expect(
      signedInPage.getByRole('region', { name: 'The library at a glance' }).or(signedInPage.getByText(/type a term to search every item you can read/i)),
    ).toBeVisible();

    await signedInPage.locator('[data-search-input]').fill(marker);
    await expect(signedInPage).toHaveURL((url) => url.searchParams.get('q') === marker, { timeout: 15_000 });
    await expect(rowFor(signedInPage, `Search Refine Target ${marker}`)).toBeVisible({ timeout: 15_000 });

    // Typing REPLACES, so Back leaves the search behind rather than rewinding
    // it one character at a time.
    await signedInPage.goBack();
    await expect(signedInPage).toHaveURL((url) => url.pathname === '/');
  });

  test('a content-type chip narrows the groups and clears again', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `searchfacet-${testInfo.workerIndex}-${Date.now()}`;
    await seedTypedCorpus(apiAsAdmin, marker);

    await signedInPage.goto(`/search?q=${marker}`);
    await expect(signedInPage.getByRole('region', { name: 'Runbook results' })).toBeVisible({ timeout: 15_000 });

    // The chip counts are read off the same groups as the headings, so they can
    // never disagree with what is listed below them.
    await expect(facet(signedInPage, 'All types')).toHaveAttribute('aria-pressed', 'true');
    await expect(facet(signedInPage, 'Runbook')).toContainText('2');
    await expect(facet(signedInPage, 'FAQ')).toContainText('1');

    await facet(signedInPage, 'Runbook').click();
    await expect(signedInPage).toHaveURL((url) => url.searchParams.get('type') === 'Runbook');
    await expect(facet(signedInPage, 'Runbook')).toHaveAttribute('aria-pressed', 'true');
    await expect(signedInPage.getByRole('region', { name: 'Runbook results' })).toBeVisible();
    await expect(signedInPage.getByRole('region', { name: 'FAQ results' })).toHaveCount(0);
    // Narrowing never hides the other chips — that is how you get back.
    await expect(facet(signedInPage, 'FAQ')).toBeVisible();

    await facet(signedInPage, 'Runbook').click();
    await expect(signedInPage).toHaveURL((url) => !url.searchParams.has('type'));
    await expect(signedInPage.getByRole('region', { name: 'FAQ results' })).toBeVisible();
  });

  test('where the query matched is marked in the title and the snippet', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    // One unbroken token, so the index's tokenizer and the highlight agree on
    // exactly what "the match" is.
    const marker = `searchmark${testInfo.workerIndex}x${Date.now()}`;
    await createPageViaApi(apiAsAdmin, {
      title: `Highlighted ${marker} result`,
      body: `Some words before the ${marker} and some after it.`,
      status: 'published',
      frontmatter: { type: 'Concept' },
    });

    await signedInPage.goto(`/search?q=${marker}`);
    const row = rowFor(signedInPage, `Highlighted ${marker} result`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator('.kp-result-row__title mark')).toHaveText([new RegExp(`^${marker}$`, 'i')]);
    await expect(row.locator('.kp-result-row__snippet mark').first()).toHaveText(new RegExp(`^${marker}$`, 'i'));
    // Decoration only: the title still reads as one string.
    await expect(row.locator('.kp-result-row__title')).toHaveText(`Highlighted ${marker} result`);
    // The mark keeps the row's text colour; only the background changes.
    const [markColor, titleColor, markBg] = await row.locator('.kp-result-row__title').evaluate((title) => {
      const mark = title.querySelector('mark')!;
      return [getComputedStyle(mark).color, getComputedStyle(title).color, getComputedStyle(mark).backgroundColor];
    });
    expect(markColor).toBe(titleColor);
    expect(markBg).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('Sort offers Recently verified, and choosing it is in the URL', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `searchsort-${testInfo.workerIndex}-${Date.now()}`;
    await seedTypedCorpus(apiAsAdmin, marker);
    await signedInPage.goto(`/search?q=${marker}`);

    const sort = signedInPage.getByRole('combobox', { name: 'Sort results' });
    await expect(sort).toBeVisible({ timeout: 15_000 });
    await expect(sort.locator('option')).toHaveText(['Relevance', 'Newest', 'Oldest', 'A–Z', 'Recently verified']);
    await sort.selectOption('verified');
    await expect(signedInPage).toHaveURL((url) => url.searchParams.get('sort') === 'verified' && url.searchParams.get('q') === marker);
    await expect(sort).toHaveValue('verified');
    await expect(signedInPage.locator('.Search__row')).toHaveCount(3, { timeout: 15_000 });
  });

  test('a draft says Draft; its published neighbour says nothing', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `searchdraft-${testInfo.workerIndex}-${Date.now()}`;
    await createPageViaApi(apiAsAdmin, { title: `Search Draft ${marker}`, body: `${marker} not live yet`, status: 'draft', frontmatter: { type: 'Runbook' } });
    await createPageViaApi(apiAsAdmin, { title: `Search Live ${marker}`, body: `${marker} live`, status: 'published', frontmatter: { type: 'Runbook' } });

    // The administrator who wrote the draft can find it; a chip is how the row
    // says it is not live — a state worth a word, unlike plain "Published".
    await signedInPage.goto(`/search?q=${marker}`);
    const draft = rowFor(signedInPage, `Search Draft ${marker}`);
    const live = rowFor(signedInPage, `Search Live ${marker}`);
    await expect(draft).toBeVisible({ timeout: 15_000 });
    await expect(draft.locator('.kp-badge[data-tone="draft"]')).toHaveText('Draft');
    await expect(live).toBeVisible();
    await expect(live.locator('.kp-badge')).toHaveCount(0);
    await expect(live.getByText('Published', { exact: true })).toHaveCount(0);
  });

  test('a query with no matches explains itself and offers the whole library', async ({ signedInPage }) => {
    const marker = `nosuchterm-${Date.now()}`;
    await signedInPage.goto(`/search?q=${marker}`);

    const empty = signedInPage.locator('.Search__empty');
    await expect(empty).toBeVisible({ timeout: 15_000 });
    await expect(empty.getByRole('heading', { level: 2 })).toContainText(`No matches for ‘${marker}’`);
    await expect(empty).toContainText(/try a broader term/i);

    await empty.getByRole('link', { name: /browse the whole library/i }).click();
    await expect(signedInPage).toHaveURL((url) => url.pathname === '/browse' && url.searchParams.get('view') === 'grouped');
  });

  test('the page is the door to Browse and to the tag view', async ({ signedInPage }) => {
    // Browse and Tags left the sidebar (§3.4), so this page is how a reader
    // without a query still reaches them.
    await signedInPage.goto('/search');
    const ways = signedInPage.getByRole('navigation', { name: /other ways into the library/i });
    await expect(ways).toBeVisible();

    await ways.getByRole('link', { name: /browse by tag/i }).click();
    await expect(signedInPage).toHaveURL((url) => url.pathname === '/browse' && url.searchParams.get('view') === 'tags');

    await signedInPage.goto('/search');
    await ways.getByRole('link', { name: /browse all items/i }).click();
    await expect(signedInPage).toHaveURL((url) => url.pathname === '/browse' && url.searchParams.get('view') === 'grouped');

    await signedInPage.goto('/search');
    await ways.getByRole('link', { name: /^topics$/i }).click();
    await expect(signedInPage).toHaveURL(/\/topics$/);
  });
});

/** True when neither the document nor the page's scroll container scrolls sideways. */
async function hasNoHorizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector<HTMLElement>('.Search');
    return doc.scrollWidth <= window.innerWidth && (!main || main.scrollWidth <= main.clientWidth);
  });
}

test.describe('the search page on a wide screen', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('facets sit in a sidebar beside a readable results column, and toggling one filters', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `searchwide-${testInfo.workerIndex}-${Date.now()}`;
    await seedTypedCorpus(apiAsAdmin, marker);
    await signedInPage.goto(`/search?q=${marker}`);

    const sidebar = signedInPage.getByRole('complementary', { name: 'Filters' });
    const runbooks = signedInPage.getByRole('region', { name: 'Runbook results' });
    await expect(runbooks).toBeVisible({ timeout: 15_000 });
    await expect(sidebar).toBeVisible();
    // The narrow layout's button is not offered when the sidebar is there.
    await expect(signedInPage.getByRole('button', { name: /^Filters/ })).toHaveCount(0);

    // Sidebar to the left of the results; the results column is bounded by the
    // page cap however wide the screen is: 85rem less the 16.5rem sidebar and
    // its 2.5rem gap (tokens.css `--kp-page-width`, 2026-09-13).
    const sideBox = (await sidebar.boundingBox())!;
    const resultsBox = (await runbooks.boundingBox())!;
    expect(sideBox.x + sideBox.width).toBeLessThanOrEqual(resultsBox.x);
    const remPx = await signedInPage.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    expect(resultsBox.width).toBeLessThanOrEqual((85 - 16.5 - 2.5) * remPx + 1);

    const typeGroup = sidebar.getByRole('group', { name: 'Type' });
    await expect(typeGroup.getByRole('button', { name: /^All types/ })).toHaveAttribute('aria-pressed', 'true');
    await typeGroup.getByRole('button', { name: /^Runbook/ }).click();
    await expect(signedInPage).toHaveURL((url) => url.searchParams.get('type') === 'Runbook' && url.searchParams.get('q') === marker);
    await expect(typeGroup.getByRole('button', { name: /^Runbook/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(signedInPage.getByRole('region', { name: 'FAQ results' })).toHaveCount(0);
    // Still there after the refetch: the column does not collapse under the pointer.
    await expect(sidebar).toBeVisible();

    await sidebar.getByRole('button', { name: 'Clear filters' }).click();
    await expect(signedInPage).toHaveURL((url) => !url.searchParams.has('type') && url.searchParams.get('q') === marker);
    await expect(signedInPage.getByRole('region', { name: 'FAQ results' })).toBeVisible();
    expect(await hasNoHorizontalOverflow(signedInPage)).toBe(true);
  });

  test('the Trust facet writes is= to the URL, as is: reads in a query', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `searchtrust-${testInfo.workerIndex}-${Date.now()}`;
    await seedTypedCorpus(apiAsAdmin, marker);
    await signedInPage.goto(`/search?q=${marker}`);

    const trust = signedInPage.getByRole('complementary', { name: 'Filters' }).getByRole('group', { name: 'Trust' });
    await expect(trust).toBeVisible({ timeout: 15_000 });
    await expect(trust.getByRole('button', { name: /^Any trust/ })).toHaveAttribute('aria-pressed', 'true');
    // Fresh fixtures are unverified; the chip is labelled, the URL carries the key.
    const unverified = trust.getByRole('button', { name: /^Unverified/ });
    await expect(unverified).toContainText('3');
    await unverified.click();
    await expect(signedInPage).toHaveURL((url) => url.searchParams.getAll('is').join(',') === 'unverified' && url.searchParams.get('q') === marker);
    await expect(trust.getByRole('button', { name: /^Unverified/ })).toHaveAttribute('aria-pressed', 'true');

    await trust.getByRole('button', { name: /^Any trust/ }).click();
    await expect(signedInPage).toHaveURL((url) => !url.searchParams.has('is'));
    // All three matches are published, so a Status group would be one option
    // that narrows nothing: it is not offered.
    await expect(signedInPage.getByRole('complementary', { name: 'Filters' }).getByRole('group', { name: 'Status' })).toHaveCount(0);
  });

  test('a long facet group shows six, folds the rest behind "Show N more", and never folds an active option', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `searchfold-${testInfo.workerIndex}-${Date.now()}`;
    const tag = await seedManyTags(apiAsAdmin, marker);
    await signedInPage.goto(`/search?q=${marker}`);

    const tags = signedInPage.getByRole('complementary', { name: 'Filters' }).getByRole('group', { name: 'Tag' });
    await expect(tags).toBeVisible({ timeout: 15_000 });

    // "All tags" plus the top six by count; the two single-count tags fold.
    await expect(tags.locator('.Search__facet')).toHaveCount(7);
    await expect(tagOption(tags, tag('f'))).toBeVisible();
    await expect(tagOption(tags, tag('g'))).toHaveCount(0);
    const more = tags.getByRole('button', { name: 'Show 2 more' });
    await expect(more).toHaveAttribute('aria-expanded', 'false');

    await more.click();
    const fewer = tags.getByRole('button', { name: 'Show fewer' });
    await expect(fewer).toHaveAttribute('aria-expanded', 'true');
    await expect(tags.locator('.Search__facet')).toHaveCount(9);

    // Choose an option from below the cut, then fold the list again: the
    // chosen one stays in view (and pressed); only its unchosen neighbour folds.
    await tagOption(tags, tag('h')).click();
    await expect(signedInPage).toHaveURL((url) => url.searchParams.get('tag') === tag('h'));
    await expect(tagOption(tags, tag('h'))).toHaveAttribute('aria-pressed', 'true');
    await fewer.click();
    await expect(tagOption(tags, tag('h'))).toBeVisible();
    await expect(tagOption(tags, tag('h'))).toHaveAttribute('aria-pressed', 'true');
    await expect(tagOption(tags, tag('g'))).toHaveCount(0);
    await expect(tags.getByRole('button', { name: 'Show 1 more' })).toHaveAttribute('aria-expanded', 'false');
  });
});

test.describe('the search page at medium width', () => {
  test.use({ viewport: { width: 820, height: 1000 } });

  test('facets become chip rows above the results', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `searchmedium-${testInfo.workerIndex}-${Date.now()}`;
    await seedTypedCorpus(apiAsAdmin, marker);
    await signedInPage.goto(`/search?q=${marker}`);

    const filters = signedInPage.getByRole('complementary', { name: 'Filters' });
    const runbooks = signedInPage.getByRole('region', { name: 'Runbook results' });
    await expect(runbooks).toBeVisible({ timeout: 15_000 });
    await expect(filters).toBeVisible();
    await expect(signedInPage.getByRole('button', { name: /^Filters/ })).toHaveCount(0);

    // Above, not beside: the chips end before the results begin.
    const filtersBox = (await filters.boundingBox())!;
    const resultsBox = (await runbooks.boundingBox())!;
    expect(filtersBox.y + filtersBox.height).toBeLessThanOrEqual(resultsBox.y);
    // A row: "All types" and "Runbook" share a line.
    const all = (await facet(signedInPage, 'All types').boundingBox())!;
    const runbook = (await facet(signedInPage, 'Runbook').boundingBox())!;
    expect(Math.abs(all.y - runbook.y)).toBeLessThan(4);
    expect(await hasNoHorizontalOverflow(signedInPage)).toBe(true);
  });

  test('a long facet row ends in a "Show N more" chip', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `searchfoldmid-${testInfo.workerIndex}-${Date.now()}`;
    const tag = await seedManyTags(apiAsAdmin, marker);
    await signedInPage.goto(`/search?q=${marker}`);

    const tags = signedInPage.getByRole('complementary', { name: 'Filters' }).getByRole('group', { name: 'Tag' });
    await expect(tags).toBeVisible({ timeout: 15_000 });
    await expect(tags.locator('.Search__facet')).toHaveCount(7);
    await tags.getByRole('button', { name: 'Show 2 more' }).click();
    await expect(tags.locator('.Search__facet')).toHaveCount(9);
    await expect(tagOption(tags, tag('h'))).toBeVisible();
    expect(await hasNoHorizontalOverflow(signedInPage)).toBe(true);
  });
});

test.describe('the search page on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a Filters button opens the facets in a dialog that applies choices live', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `searchphone-${testInfo.workerIndex}-${Date.now()}`;
    await seedTypedCorpus(apiAsAdmin, marker);
    await signedInPage.goto(`/search?q=${marker}`);

    await expect(signedInPage.getByRole('region', { name: 'Runbook results' })).toBeVisible({ timeout: 15_000 });
    // No sidebar and no chip rows on a phone: just the button.
    await expect(signedInPage.getByRole('complementary', { name: 'Filters' })).toHaveCount(0);
    const openButton = signedInPage.getByRole('button', { name: 'Filters', exact: true });
    await expect(openButton).toBeVisible();
    expect(await hasNoHorizontalOverflow(signedInPage)).toBe(true);

    await openButton.click();
    const dialog = signedInPage.getByRole('dialog', { name: 'Filters' });
    await expect(dialog).toBeVisible();
    // Focus moved into the dialog.
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);

    await dialog.getByRole('button', { name: /^Runbook/ }).click();
    await expect(signedInPage).toHaveURL((url) => url.searchParams.get('type') === 'Runbook' && url.searchParams.get('q') === marker);
    // Live: the dialog stays open on the new answer.
    await expect(dialog.getByRole('button', { name: /^Runbook/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog).toBeVisible();

    await signedInPage.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(signedInPage.getByRole('button', { name: 'Filters (1)' })).toBeFocused();
    await expect(signedInPage.getByRole('region', { name: 'FAQ results' })).toHaveCount(0);

    // The active filter is summarised as a removable chip above the results.
    await signedInPage.getByRole('button', { name: 'Remove Type filter Runbook' }).click();
    await expect(signedInPage).toHaveURL((url) => !url.searchParams.has('type'));
    await expect(signedInPage.getByRole('region', { name: 'FAQ results' })).toBeVisible();
    await expect(signedInPage.getByRole('button', { name: 'Filters', exact: true })).toBeVisible();
  });

  test('the Filters dialog folds a long facet group the same way', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `searchfoldphone-${testInfo.workerIndex}-${Date.now()}`;
    const tag = await seedManyTags(apiAsAdmin, marker);
    await signedInPage.goto(`/search?q=${marker}`);

    await signedInPage.getByRole('button', { name: 'Filters', exact: true }).click({ timeout: 15_000 });
    const tags = signedInPage.getByRole('dialog', { name: 'Filters' }).getByRole('group', { name: 'Tag' });
    await expect(tags.locator('.Search__facet')).toHaveCount(7);
    const more = tags.getByRole('button', { name: 'Show 2 more' });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.click();
    await expect(tags.locator('.Search__facet')).toHaveCount(9);
    await expect(tagOption(tags, tag('g'))).toBeVisible();
    await expect(tags.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
  });

  test('nothing scrolls sideways at 360px, even with a long unbroken query', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    await signedInPage.setViewportSize({ width: 360, height: 780 });
    const marker = `searchnarrow${testInfo.workerIndex}${Date.now()}averyveryverylongunbrokenmarkerthatcouldoverflow`;
    await createPageViaApi(apiAsAdmin, {
      title: `A deliberately long result title that has to wrap onto a second line on a small phone ${marker}`,
      body: `${marker} body`,
      status: 'published',
      frontmatter: { type: 'Runbook' },
    });
    await signedInPage.goto(`/search?q=${marker}`);
    await expect(signedInPage.locator('.Search__row')).toHaveCount(1, { timeout: 15_000 });
    expect(await hasNoHorizontalOverflow(signedInPage)).toBe(true);
    // The metadata line wraps inside the row rather than pushing past it.
    const row = (await signedInPage.locator('.Search__row').boundingBox())!;
    const meta = (await signedInPage.locator('.Search__row .kp-result-row__meta').boundingBox())!;
    expect(meta.x + meta.width).toBeLessThanOrEqual(row.x + row.width + 1);
  });
});
