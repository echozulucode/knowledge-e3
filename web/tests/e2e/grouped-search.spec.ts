/**
 * Maps to features/10-grouped-search.feature
 *
 * Grouped search (§3.5): the command palette and the browse "By type" layout
 * render the server's content-type groups; a row speaks up only for a state
 * worth a word (Needs review, Draft, …) and a verified trust tier; the
 * sidebar carries the durable Topics and Latest destinations (§3.4).
 *
 * The palette is the header's quick search (2026-09-12): with a query, its
 * first row is "Search all results for ‘q’" and is the default Enter target;
 * the grouped results follow. Recent searches are covered by
 * quick-search-recents.spec.ts.
 */
import { test, expect, createPageViaApi } from './fixtures.js';
import type { Page } from '@playwright/test';

async function openPaletteAndSearch(page: Page, term: string) {
  await page.keyboard.press('Meta+k');
  const palette = page.locator('.kp-palette-modal');
  await expect(palette).toBeVisible({ timeout: 2000 });
  await palette.locator('.kp-palette-input').fill(term);
  return palette;
}

test.describe('grouped search', () => {
  test('command palette groups results by content type with trust labels and See all', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `groupedsearch-${testInfo.workerIndex}-${Date.now()}`;
    await createPageViaApi(apiAsAdmin, { title: `Grouped Runbook A ${marker}`, body: `${marker} rotate keys`, status: 'published', frontmatter: { type: 'Runbook' } });
    await createPageViaApi(apiAsAdmin, { title: `Grouped Runbook B ${marker}`, body: `${marker} restart worker`, status: 'published', frontmatter: { type: 'Runbook' } });
    await createPageViaApi(apiAsAdmin, { title: `Grouped FAQ ${marker}`, body: `${marker} why does it retry`, status: 'published', frontmatter: { type: 'FAQ' } });

    await signedInPage.goto('/');
    const palette = await openPaletteAndSearch(signedInPage, marker);

    const runbookGroup = palette.getByRole('group', { name: 'Runbook results' });
    const faqGroup = palette.getByRole('group', { name: 'FAQ results' });
    await expect(runbookGroup).toBeVisible({ timeout: 10_000 });
    await expect(faqGroup).toBeVisible();
    await expect(runbookGroup.locator('.kp-palette-item')).toHaveCount(2);
    await expect(faqGroup.locator('.kp-palette-item')).toHaveCount(1);
    await expect(runbookGroup.getByRole('button', { name: /see all 2 runbook results/i })).toBeVisible();

    // A plain published, unverified row is title, snippet and ONE quiet line:
    // topic · type · Updated <date>. No chip at all (home plan R2.4): the type
    // is text, since the group heading already names it; "Published", the match
    // reasons and "Recently updated" said nothing a reader could use; and an
    // unverified tier shows no trust signal, because a warning on every row
    // trains readers to ignore it. The tier is stated on the article instead.
    const faqRow = faqGroup.locator('.kp-palette-item');
    await expect(faqRow.locator('.kp-result-row__meta .kp-item-meta__part')).toHaveText([/^[^·]+$/, /^·\s*FAQ$/, /^·\s*Updated \S/]);
    await expect(faqRow.locator('.kp-type-badge')).toHaveCount(0);
    await expect(faqRow.locator('.kp-badge')).toHaveCount(0);
    await expect(faqRow.locator('.kp-trust-mark')).toHaveCount(0);
    await expect(faqRow.getByText('Unverified')).toHaveCount(0);
    for (const chip of ['Published', 'Title match', 'Body match', 'Recently updated']) {
      await expect(faqRow.getByText(chip, { exact: true })).toHaveCount(0);
    }
    // Why it matched survives only as data, for tooling — never as text.
    await expect(faqRow.locator('.kp-result-row')).toHaveAttribute('data-match', /\btitle\b/);

    // See all hands the type off to /search — the one results page, the same
    // one the palette's "Search all results" row reaches (R2.3), not Browse —
    // keeping the query and pressing the type's facet.
    await runbookGroup.getByRole('button', { name: /see all 2 runbook results/i }).click();
    await expect(signedInPage).toHaveURL((url) => url.pathname === '/search' && url.searchParams.get('q') === marker && url.searchParams.get('type') === 'Runbook');
    await expect(signedInPage.locator('.Search__row').filter({ hasText: `Grouped Runbook A ${marker}` })).toBeVisible({ timeout: 10_000 });
    await expect(signedInPage.locator('.Search__row').filter({ hasText: `Grouped Runbook B ${marker}` })).toBeVisible();
    await expect(signedInPage.locator('.Search__row').filter({ hasText: `Grouped FAQ ${marker}` })).toHaveCount(0);
  });

  test('the palette marks where the query matched, as /search does', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    // One unbroken token, so the tokenizer and the highlight agree on the match.
    const marker = `palettemark${testInfo.workerIndex}x${Date.now()}`;
    await createPageViaApi(apiAsAdmin, { title: `Marked ${marker} runbook`, body: `Steps for ${marker} recovery.`, status: 'published', frontmatter: { type: 'Runbook' } });

    await signedInPage.goto('/');
    const palette = await openPaletteAndSearch(signedInPage, marker);
    const row = palette.locator('.kp-palette-item').filter({ hasText: `Marked ${marker} runbook` });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.locator('.kp-result-row__title mark')).toHaveText([new RegExp(`^${marker}$`, 'i')]);
    await expect(row.locator('.kp-result-row__snippet mark').first()).toHaveText(new RegExp(`^${marker}$`, 'i'));
    await expect(row.locator('.kp-result-row__title')).toHaveText(`Marked ${marker} runbook`);
  });

  test('the palette hands "see all results" to /search, not Browse', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `palettesearch-${testInfo.workerIndex}-${Date.now()}`;
    await createPageViaApi(apiAsAdmin, { title: `Palette Handoff ${marker}`, body: `${marker} body`, status: 'published', frontmatter: { type: 'Runbook' } });

    await signedInPage.goto('/');
    const palette = await openPaletteAndSearch(signedInPage, marker);
    await expect(palette.locator('.kp-palette-item')).toHaveCount(1, { timeout: 10_000 });
    // The palette names the destination it actually hands off to.
    await expect(palette).not.toContainText('Browse');
    const searchAll = palette.locator('.kp-palette-seeall');
    await expect(searchAll).toHaveText(`Search all results for ‘${marker}’`);
    await searchAll.click();
    await expect(signedInPage).toHaveURL((url) => url.pathname === '/search' && url.searchParams.get('q') === marker);
    await expect(signedInPage.locator('.Search__row').filter({ hasText: `Palette Handoff ${marker}` })).toBeVisible({ timeout: 10_000 });
  });

  test('Enter in the quick search box opens every result on /search', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `paletteenter-${testInfo.workerIndex}-${Date.now()}`;
    await createPageViaApi(apiAsAdmin, { title: `Palette Enter ${marker}`, body: `${marker} body`, status: 'published', frontmatter: { type: 'Runbook' } });

    await signedInPage.goto('/');
    const palette = await openPaletteAndSearch(signedInPage, marker);
    await expect(palette.locator('.kp-palette-item')).toHaveCount(1, { timeout: 10_000 });
    // Nothing moved yet, so the highlighted row is "Search all results" — the
    // row says what Enter will do before the reader presses it.
    await expect(palette.locator('.kp-palette-seeall')).toHaveClass(/selected/);
    await signedInPage.keyboard.press('Enter');
    await expect(signedInPage).toHaveURL((url) => url.pathname === '/search' && url.searchParams.get('q') === marker);
    await expect(signedInPage.locator('.kp-palette-modal')).toHaveCount(0);
  });

  test('a stale item is labelled Needs review in the palette', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `stalesearch-${testInfo.workerIndex}-${Date.now()}`;
    await createPageViaApi(apiAsAdmin, {
      title: `Stale Concept ${marker}`,
      body: `${marker} old guidance`,
      status: 'published',
      frontmatter: { type: 'Concept', stale_after: '2020-01-01' },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `Fresh Concept ${marker}`,
      body: `${marker} current guidance`,
      status: 'published',
      frontmatter: { type: 'Concept', stale_after: '2099-01-01' },
    });

    await signedInPage.goto('/');
    const palette = await openPaletteAndSearch(signedInPage, marker);

    const staleRow = palette.locator('.kp-palette-item').filter({ hasText: `Stale Concept ${marker}` });
    const freshRow = palette.locator('.kp-palette-item').filter({ hasText: `Fresh Concept ${marker}` });
    await expect(staleRow).toBeVisible({ timeout: 10_000 });
    await expect(staleRow.getByRole('status')).toHaveText('Needs review');
    await expect(freshRow).toBeVisible();
    await expect(freshRow.locator('.kp-badge[data-tone="needs-review"]')).toHaveCount(0);
  });

  test('keyboard selection walks every group in visual order and Enter opens the highlighted result', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `keysearch-${testInfo.workerIndex}-${Date.now()}`;
    await createPageViaApi(apiAsAdmin, { title: `Key Runbook ${marker}`, body: `${marker} one`, status: 'published', frontmatter: { type: 'Runbook' } });
    await createPageViaApi(apiAsAdmin, { title: `Key FAQ ${marker}`, body: `${marker} two`, status: 'published', frontmatter: { type: 'FAQ' } });
    await createPageViaApi(apiAsAdmin, { title: `Key How-To ${marker}`, body: `${marker} three`, status: 'published', frontmatter: { type: 'How-To' } });

    await signedInPage.goto('/');
    const palette = await openPaletteAndSearch(signedInPage, marker);
    const rows = palette.locator('.kp-palette-item');
    await expect(rows).toHaveCount(3, { timeout: 10_000 });
    await expect(palette.locator('.kp-palette-group')).toHaveCount(3);

    // Selection starts on "Search all results" (the default Enter target), then
    // crosses group boundaries in DOM order and wraps back to the top.
    const searchAll = palette.locator('.kp-palette-seeall');
    await expect(searchAll).toHaveClass(/selected/);
    await signedInPage.keyboard.press('ArrowDown');
    await expect(rows.nth(0)).toHaveClass(/selected/);
    await expect(searchAll).not.toHaveClass(/selected/);
    await signedInPage.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toHaveClass(/selected/);
    await signedInPage.keyboard.press('ArrowDown');
    await expect(rows.nth(2)).toHaveClass(/selected/);
    await signedInPage.keyboard.press('ArrowDown');
    await expect(searchAll).toHaveClass(/selected/);
    await signedInPage.keyboard.press('ArrowUp');
    await expect(rows.nth(2)).toHaveClass(/selected/);

    const highlightedTitle = (await rows.nth(2).locator('.kp-result-row__title').textContent()) ?? '';
    await signedInPage.keyboard.press('Enter');
    await expect(signedInPage).toHaveURL(/\/p\//);
    await expect(signedInPage.locator('.kp-palette-modal')).toHaveCount(0);
    await expect(signedInPage.getByRole('heading', { name: highlightedTitle })).toBeVisible({ timeout: 10_000 });
  });

  test('browse shows results grouped by type via view=types', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `typesview-${testInfo.workerIndex}-${Date.now()}`;
    await createPageViaApi(apiAsAdmin, { title: `Types Runbook ${marker}`, body: `${marker} alpha`, status: 'published', frontmatter: { type: 'Runbook' } });
    await createPageViaApi(apiAsAdmin, { title: `Types FAQ ${marker}`, body: `${marker} beta`, status: 'published', frontmatter: { type: 'FAQ' } });

    await signedInPage.goto(`/browse?view=types&q=${marker}`);

    await expect(signedInPage.getByRole('button', { name: 'By type' })).toHaveAttribute('aria-pressed', 'true');
    const runbookGroup = signedInPage.getByRole('region', { name: 'Runbook type group' });
    const faqGroup = signedInPage.getByRole('region', { name: 'FAQ type group' });
    await expect(runbookGroup).toBeVisible({ timeout: 10_000 });
    await expect(faqGroup).toBeVisible();
    await expect(runbookGroup.getByRole('heading', { name: 'Runbook' })).toBeVisible();

    const row = runbookGroup.locator('.PageList__ResultItem').filter({ hasText: `Types Runbook ${marker}` });
    await expect(row).toBeVisible();
    // The shared result row: the type is text on the metadata line, not a chip.
    await expect(row.locator('.kp-result-row__meta')).toContainText('Runbook');
    await expect(row.locator('.kp-type-badge')).toHaveCount(0);
    // Quiet on an index surface: nothing for an unverified item (R2.4).
    await expect(row.locator('.kp-trust-mark')).toHaveCount(0);
    await expect(row.getByText('Unverified')).toHaveCount(0);
    await expect(faqGroup.locator('.PageList__ResultItem').filter({ hasText: `Types Runbook ${marker}` })).toHaveCount(0);

    // See all focuses the type in the Cards view, keeping the query.
    await runbookGroup.getByRole('button', { name: /see all 1 runbook items/i }).click();
    await expect(signedInPage).toHaveURL((url) => url.searchParams.get('view') === 'cards' && url.searchParams.get('type') === 'Runbook' && url.searchParams.get('q') === marker);
    await expect(signedInPage.locator('.PageList__Card').filter({ hasText: `Types Runbook ${marker}` })).toBeVisible();
  });

  test('cards carry freshness and trust labels', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `cardlabels-${testInfo.workerIndex}-${Date.now()}`;
    await createPageViaApi(apiAsAdmin, {
      title: `Labelled Card ${marker}`,
      body: `${marker} body`,
      status: 'published',
      frontmatter: { type: 'Concept', stale_after: '2020-01-01' },
    });

    await signedInPage.goto(`/browse?q=${marker}`);
    const card = signedInPage.locator('.PageList__Card').filter({ hasText: `Labelled Card ${marker}` });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByRole('status')).toHaveText('Needs review');
    // Freshness still speaks up; an unverified tier does not (R2.4) — the card
    // is an index surface, and the article states the tier plainly.
    await expect(card.locator('.kp-trust-mark')).toHaveCount(0);
    await expect(card.getByText('Unverified')).toHaveCount(0);
    // The card's primary action semantics are unchanged.
    await expect(card.getByRole('button', { name: `Open Labelled Card ${marker}` })).toBeVisible();
  });
});

test.describe('sidebar hub destinations', () => {
  /**
   * The durable destinations (§3.4): Home · Topics · Latest · (Review) ·
   * Sections · Search. Browse and Tags deliberately LEFT this list — they are
   * reached from /search, from a Topic landing and from the palette — and
   * Search became a route rather than a palette action. The rail is short on
   * purpose, so its exact contents are worth asserting.
   */
  test('the sidebar offers the durable destinations and neither Browse nor Tags', async ({ signedInPage }) => {
    await signedInPage.goto('/');
    const nav = signedInPage.locator('.kp-sidebar-nav');
    const labels = await nav.locator('.kp-sidebar-item').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label')));
    // `Review` is inserted, not appended, so the order stays durable; it shows
    // for admins (this fixture) and for authors with an item in review.
    expect(labels).toEqual(['Home', 'Topics', 'Latest', 'Review', 'Sections', 'Search']);

    await nav.getByRole('button', { name: 'Topics' }).click();
    await expect(signedInPage).toHaveURL(/\/topics$/);
    await expect(nav.getByRole('button', { name: 'Topics' })).toHaveClass(/active/);

    await nav.getByRole('button', { name: 'Latest' }).click();
    await expect(signedInPage).toHaveURL(/\/latest$/);
    await expect(nav.getByRole('button', { name: 'Latest' })).toHaveClass(/active/);

    // Search is a destination now, not a way of opening the palette.
    await nav.getByRole('button', { name: 'Search' }).click();
    await expect(signedInPage).toHaveURL(/\/search$/);
    await expect(signedInPage.locator('.kp-palette-modal')).toHaveCount(0);
    await expect(signedInPage.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
  });
});
