/**
 * Maps to features/10-grouped-search.feature (Rule: Quick search remembers
 * recent searches).
 *
 * The header's quick search (⌘K / the "Search…" trigger) shows the reader's
 * recent searches on an empty box (Eric, 2026-09-12). Recents are kept per
 * browser in localStorage under `kp.recentSearches.v1:<userId|anon>` — nothing
 * is stored server-side — so every test starts from a fresh browser context
 * with no recents.
 *
 * A search is recorded when it is submitted to /search (from the palette, the
 * page's own box, or a topic landing's "Search in <topic>" box) or when a
 * result is opened from the palette with a query. Typing alone does not record.
 *
 * Selectors the surface exposes:
 *   - .kp-palette-modal — role=dialog "Quick search"; input aria-label "Search"
 *   - group "Recent searches" with one run button per entry (name = the query)
 *     and a "Remove <query> from recent searches" button
 *   - button "Clear recent searches"
 *   - .kp-palette-seeall — "Search all results for ‘q’"
 */
import { test, expect, createPageViaApi } from './fixtures.js';
import type { Page } from '@playwright/test';

const KEY_PREFIX = 'kp.recentSearches.v1:';

async function openPalette(page: Page) {
  await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog', { name: 'Quick search' });
  await expect(palette).toBeVisible({ timeout: 2000 });
  return palette;
}

/** Submit a query to /search through the palette (type, then Enter). */
async function searchFromPalette(page: Page, term: string) {
  const palette = await openPalette(page);
  await palette.getByRole('textbox', { name: 'Search' }).fill(term);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL((url) => url.pathname === '/search' && url.searchParams.get('q') === term);
  await expect(palette).toHaveCount(0);
}

function recentsGroup(page: Page) {
  return page.getByRole('dialog', { name: 'Quick search' }).getByRole('group', { name: 'Recent searches' });
}

/** The entries as shown, most recent first. */
async function recentEntries(page: Page) {
  return recentsGroup(page).locator('.kp-palette-recent-text').allTextContents();
}

test.describe('quick search recent searches', () => {
  test('a search submitted from the palette is listed after reopening and survives a reload', async ({ signedInPage }) => {
    const term = `recent-${Date.now()}`;
    await signedInPage.goto('/');

    // A fresh browser has nothing to show, and says so.
    await openPalette(signedInPage);
    await expect(recentsGroup(signedInPage)).toContainText(/searches you run appear here/i);
    await signedInPage.keyboard.press('Escape');

    await searchFromPalette(signedInPage, term);

    // Reopening starts on an empty box, so the recents are what shows.
    const palette = await openPalette(signedInPage);
    await expect(palette.getByRole('textbox', { name: 'Search' })).toHaveValue('');
    await expect(recentsGroup(signedInPage).getByRole('button', { name: term, exact: true })).toBeVisible();

    await signedInPage.reload();
    await openPalette(signedInPage);
    await expect(recentsGroup(signedInPage).getByRole('button', { name: term, exact: true })).toBeVisible();
  });

  test('recents are most recent first, de-duplicated ignoring case, and re-run in the palette', async ({ signedInPage }) => {
    const stamp = Date.now();
    const alpha = `alpha-${stamp}`;
    const beta = `beta-${stamp}`;
    await signedInPage.goto('/');

    await searchFromPalette(signedInPage, alpha);
    // The /search page's own box records a submitted search too.
    const box = signedInPage.locator('[data-search-input]');
    await box.fill(beta);
    await box.press('Enter');
    await expect(signedInPage).toHaveURL((url) => url.searchParams.get('q') === beta);
    await searchFromPalette(signedInPage, alpha.toUpperCase());

    await openPalette(signedInPage);
    // One entry per search regardless of case; the latest casing wins.
    await expect.poll(() => recentEntries(signedInPage)).toEqual([alpha.toUpperCase(), beta]);

    // Arrow keys walk the recents; Enter fills the box and runs that query here.
    await signedInPage.keyboard.press('ArrowDown');
    await expect(recentsGroup(signedInPage).locator('.kp-palette-recent').nth(1)).toHaveClass(/selected/);
    await signedInPage.keyboard.press('Enter');
    const palette = signedInPage.getByRole('dialog', { name: 'Quick search' });
    await expect(palette.getByRole('textbox', { name: 'Search' })).toHaveValue(beta);
    await expect(palette.locator('.kp-palette-seeall')).toHaveText(`Search all results for ‘${beta}’`);
    await expect(palette.getByRole('textbox', { name: 'Search' })).toBeFocused();
  });

  test('a recent search can be removed, and the list cleared', async ({ signedInPage }) => {
    const stamp = Date.now();
    const keep = `keep-${stamp}`;
    const drop = `drop-${stamp}`;
    await signedInPage.goto('/');
    await searchFromPalette(signedInPage, keep);
    await searchFromPalette(signedInPage, drop);

    await openPalette(signedInPage);
    await expect.poll(() => recentEntries(signedInPage)).toEqual([drop, keep]);

    await recentsGroup(signedInPage).getByRole('button', { name: `Remove ${drop} from recent searches` }).click();
    await expect.poll(() => recentEntries(signedInPage)).toEqual([keep]);
    // Focus returns to the box rather than falling to the page.
    await expect(signedInPage.getByRole('dialog', { name: 'Quick search' }).getByRole('textbox', { name: 'Search' })).toBeFocused();

    await recentsGroup(signedInPage).getByRole('button', { name: 'Clear recent searches' }).click();
    await expect(recentsGroup(signedInPage)).toContainText(/searches you run appear here/i);
    await expect(recentsGroup(signedInPage).locator('.kp-palette-recent')).toHaveCount(0);

    // Cleared means gone, not hidden until the next reload.
    await signedInPage.reload();
    await openPalette(signedInPage);
    await expect(recentsGroup(signedInPage).locator('.kp-palette-recent')).toHaveCount(0);
  });

  test('typing alone records nothing; opening a result with a query records it', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const marker = `recentopen-${testInfo.workerIndex}-${Date.now()}`;
    const item = await createPageViaApi(apiAsAdmin, {
      title: `Recent Open ${marker}`,
      body: `${marker} body`,
      status: 'published',
      frontmatter: { type: 'Runbook' },
    });
    await signedInPage.goto('/');

    let palette = await openPalette(signedInPage);
    await palette.getByRole('textbox', { name: 'Search' }).fill(marker);
    await expect(palette.locator('.kp-palette-item')).toHaveCount(1, { timeout: 10_000 });
    await signedInPage.keyboard.press('Escape');

    palette = await openPalette(signedInPage);
    await expect(recentsGroup(signedInPage).locator('.kp-palette-recent')).toHaveCount(0);

    await palette.getByRole('textbox', { name: 'Search' }).fill(marker);
    await palette.locator('.kp-palette-item').filter({ hasText: `Recent Open ${marker}` }).click();
    await expect(signedInPage).toHaveURL((url) => url.pathname === `/p/${item.slug}`);

    await openPalette(signedInPage);
    await expect(recentsGroup(signedInPage).getByRole('button', { name: marker, exact: true })).toBeVisible();
  });

  test('recents are kept under the signed-in account, apart from the signed-out list', async ({ signedInPage }) => {
    const term = `mine-${Date.now()}`;
    const anonTerm = `anon-only-${Date.now()}`;
    await signedInPage.goto('/');
    await searchFromPalette(signedInPage, term);

    const me = await (await signedInPage.request.get('/api/v1/me')).json();
    const userId: string = me.user.id;
    const keys = await signedInPage.evaluate((prefix) => Object.keys(localStorage).filter((k) => k.startsWith(prefix)), KEY_PREFIX);
    expect(keys).toEqual([`${KEY_PREFIX}${userId}`]);
    const stored = await signedInPage.evaluate((key) => localStorage.getItem(key), `${KEY_PREFIX}${userId}`);
    expect(JSON.parse(stored!)).toEqual([term]);

    // A signed-out visitor's list on the same browser is never shown to an account.
    await signedInPage.evaluate(
      ([key, value]) => localStorage.setItem(key!, value!),
      [`${KEY_PREFIX}anon`, JSON.stringify([anonTerm])],
    );
    await signedInPage.reload();
    await openPalette(signedInPage);
    await expect(recentsGroup(signedInPage).getByRole('button', { name: term, exact: true })).toBeVisible();
    await expect(recentsGroup(signedInPage).getByText(anonTerm)).toHaveCount(0);
  });

  test("a search submitted from a topic landing's box is remembered too — the query, not the scope", async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const slug = `recents-topic-${suffix}`;
    const name = `Recents Topic ${suffix}`;
    const seed = await apiAsAdmin.post('/api/v1/topics', { data: { name, slug, description: 'Recents fixture.', presentation: 'wiki' } });
    if (!seed.ok()) throw new Error(`seed topic failed: ${seed.status()} ${await seed.text()}`);
    const term = `topicrecent-${suffix}`;

    await signedInPage.goto(`/topics/${slug}`);
    const box = signedInPage.getByRole('textbox', { name: `Search in ${name}` });
    await expect(box).toBeVisible({ timeout: 15_000 });
    await box.fill(term);
    await box.press('Enter');
    await expect(signedInPage).toHaveURL((url) => url.pathname === '/search' && url.searchParams.get('q') === term && url.searchParams.get('topic') === slug);

    await openPalette(signedInPage);
    await expect(recentsGroup(signedInPage).getByRole('button', { name: term, exact: true })).toBeVisible();
  });

  test('without usable storage the quick search still searches, with no recents', async ({ signedInPage }) => {
    const term = `nostorage-${Date.now()}`;
    // Merely touching localStorage throws, as with blocked site data.
    await signedInPage.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
    });
    await signedInPage.goto('/search');
    await searchFromPalette(signedInPage, term);
    await openPalette(signedInPage);
    await expect(recentsGroup(signedInPage)).toContainText(/searches you run appear here/i);
  });
});

test.describe('quick search on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the header icon opens a full-screen quick search with the box focused', async ({ signedInPage }) => {
    const term = `phone-${Date.now()}`;
    await signedInPage.goto('/');

    const header = signedInPage.locator('.kp-header');
    // At this width the header shows the icon, not the "Search… ⌘K" pill.
    await expect(header.locator('.kp-palette-trigger')).toBeHidden();
    await header.getByRole('button', { name: 'Search', exact: true }).click();

    const palette = signedInPage.getByRole('dialog', { name: 'Quick search' });
    await expect(palette).toBeVisible();
    const box = await palette.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeLessThanOrEqual(1);
    expect(box!.width).toBeGreaterThanOrEqual(389);
    expect(box!.height).toBeGreaterThanOrEqual(840);
    await expect(palette.getByRole('textbox', { name: 'Search' })).toBeFocused();

    // No Escape key on a phone: Cancel closes it.
    await palette.getByRole('button', { name: 'Cancel' }).click();
    await expect(palette).toHaveCount(0);

    // And a search run here is remembered like anywhere else.
    await header.getByRole('button', { name: 'Search', exact: true }).click();
    await palette.getByRole('textbox', { name: 'Search' }).fill(term);
    await palette.getByRole('textbox', { name: 'Search' }).press('Enter');
    await expect(signedInPage).toHaveURL((url) => url.pathname === '/search' && url.searchParams.get('q') === term);
    await header.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(recentsGroup(signedInPage).getByRole('button', { name: term, exact: true })).toBeVisible();
  });
});
