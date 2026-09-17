/**
 * The reading pane (features/reading-pane; Eric, 2026-09-13: "Only for extra
 * wide screens, when you click on a search result or a home page item, it opens
 * the content in a right pane, similar to Claude Desktop / Codex Desktop").
 *
 * The pane exists when the ROUTE — not the window — is at least 110rem wide.
 * With the app rail collapsed (the default) a 1920px window has a 1852px route:
 * wide. A 1440px window: not wide, and nothing about the page changes.
 *
 * Selectors the surface exposes:
 *   - complementary "Reading pane: <title>" (`data-testid="reading-pane"`), its
 *     own scroll container, with a link "Open full page" and a button "Close
 *     reading pane"
 *   - `#reading-pane-title`: the article's <h1>, focused on open
 *   - the open row's link carries `aria-current="true"`
 *   - `?peek=<slug>` on `/` and `/search`
 *
 * History policy (readingPaneModel.ts `peekHistoryMode`): opening from closed
 * pushes, choosing another row replaces, following a link inside the article
 * pushes, closing pushes.
 */
import { test, expect, createPageViaApi } from './fixtures.js';
import type { APIRequestContext, Page } from '@playwright/test';

const WIDE = { width: 1920, height: 1080 };
const NARROW = { width: 1440, height: 900 };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `?peek=<slug>` present, as a whole value. */
function peekIs(slug: string): RegExp {
  return new RegExp(`[?&]peek=${escapeRegExp(slug)}(&|$)`);
}

const NO_PEEK = /^(?!.*[?&]peek=).*$/;

function pane(page: Page) {
  return page.getByTestId('reading-pane');
}

function resultLink(page: Page, title: string) {
  return page.locator('a.Search__row').filter({ hasText: title });
}

/**
 * Three published items sharing one nonsense marker, so a search for it lists
 * exactly them. The second links to the third with a wiki link.
 */
async function seedTrio(api: APIRequestContext, marker: string) {
  const target = await createPageViaApi(api, {
    title: `Pane Wiki Target ${marker}`,
    body: `${marker} — the page a wiki link inside the pane points at.`,
    status: 'published',
  });
  const first = await createPageViaApi(api, {
    title: `Pane First ${marker}`,
    body: `${marker} first body.\n\n## A heading\n\nMore text.`,
    status: 'published',
  });
  const second = await createPageViaApi(api, {
    title: `Pane Second ${marker}`,
    body: `${marker} second body. See [[Pane Wiki Target ${marker}]] for more.`,
    status: 'published',
  });
  return {
    first: { ...first, title: `Pane First ${marker}` },
    second: { ...second, title: `Pane Second ${marker}` },
    target: { ...target, title: `Pane Wiki Target ${marker}` },
  };
}

function markerFor(workerIndex: number): string {
  return `rpane${workerIndex}x${Date.now().toString(36)}`;
}

test.describe('reading pane on an extra-wide screen', () => {
  test.use({ viewport: WIDE });

  test('search: open, switch, Escape, and Back/Forward walk the states', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const marker = markerFor(testInfo.workerIndex);
    const { first, second } = await seedTrio(apiAsAdmin, marker);

    await page.goto(`/search?q=${marker}`);
    const firstRow = resultLink(page, first.title);
    const secondRow = resultLink(page, second.title);
    await expect(firstRow).toBeVisible();

    // Open: the URL names the item, the list stays, the row is marked, focus is on the title.
    await firstRow.click();
    await expect(page).toHaveURL(peekIs(first.slug));
    await expect(page).toHaveURL(new RegExp(`[?&]q=${marker}`));
    await expect(page.getByRole('complementary', { name: `Reading pane: ${first.title}` })).toBeVisible();
    await expect(page.locator('main.Search')).toBeVisible();
    await expect(secondRow).toBeVisible();
    await expect(firstRow).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('#reading-pane-title')).toHaveText(first.title);
    await expect(page.locator('#reading-pane-title')).toBeFocused();

    // The list and the pane sit side by side, not stacked.
    const listBox = (await page.locator('main.Search').boundingBox())!;
    const paneBox = (await pane(page).boundingBox())!;
    expect(paneBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width - 1);

    // Switch: another row replaces what is open.
    await secondRow.click();
    await expect(page).toHaveURL(peekIs(second.slug));
    await expect(page.getByRole('complementary', { name: `Reading pane: ${second.title}` })).toBeVisible();
    await expect(secondRow).toHaveAttribute('aria-current', 'true');
    await expect(firstRow).not.toHaveAttribute('aria-current', 'true');
    await expect(page.locator('#reading-pane-title')).toBeFocused();

    // Escape closes, and focus goes back to the row that opened it.
    await page.keyboard.press('Escape');
    await expect(pane(page)).toHaveCount(0);
    await expect(page).toHaveURL(NO_PEEK);
    await expect(secondRow).toBeFocused();

    // Back reopens what was closed; Back again is the search before anything
    // was opened (the switch replaced, so there is no entry for the first item).
    await page.goBack();
    await expect(page).toHaveURL(peekIs(second.slug));
    await expect(page.getByRole('complementary', { name: `Reading pane: ${second.title}` })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(NO_PEEK);
    await expect(page).toHaveURL(new RegExp(`[?&]q=${marker}`));
    await expect(pane(page)).toHaveCount(0);

    await page.goForward();
    await expect(page).toHaveURL(peekIs(second.slug));
    await expect(pane(page)).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(NO_PEEK);
    await expect(pane(page)).toHaveCount(0);
  });

  test('the Close button closes the pane and returns focus to the row', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const marker = markerFor(testInfo.workerIndex);
    const { first } = await seedTrio(apiAsAdmin, marker);

    await page.goto(`/search?q=${marker}`);
    const row = resultLink(page, first.title);
    await row.click();
    await expect(pane(page)).toBeVisible();

    await pane(page).getByRole('button', { name: 'Close reading pane' }).click();
    await expect(pane(page)).toHaveCount(0);
    await expect(page).toHaveURL(NO_PEEK);
    await expect(row).toBeFocused();
  });

  test('a reload with ?peek restores the pane, and a filter change keeps it open', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const marker = markerFor(testInfo.workerIndex);
    const { first } = await seedTrio(apiAsAdmin, marker);

    await page.goto(`/search?q=${marker}&peek=${first.slug}`);
    await expect(page.getByRole('complementary', { name: `Reading pane: ${first.title}` })).toBeVisible();
    await expect(resultLink(page, first.title)).toHaveAttribute('aria-current', 'true');

    await page.reload();
    await expect(page.getByRole('complementary', { name: `Reading pane: ${first.title}` })).toBeVisible();
    await expect(page).toHaveURL(peekIs(first.slug));

    // Refining the results is not closing what is being read.
    await page.getByRole('combobox', { name: 'Sort results' }).selectOption('az');
    await expect(page).toHaveURL(/[?&]sort=az/);
    await expect(page).toHaveURL(peekIs(first.slug));
    await expect(pane(page)).toBeVisible();
  });

  test('"Open full page" navigates to the item', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const marker = markerFor(testInfo.workerIndex);
    const { first } = await seedTrio(apiAsAdmin, marker);

    await page.goto(`/search?q=${marker}`);
    await resultLink(page, first.title).click();
    await expect(pane(page)).toBeVisible();

    await pane(page).getByRole('link', { name: 'Open full page' }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${escapeRegExp(first.slug)}$`));
    await expect(pane(page)).toHaveCount(0);
  });

  test('a modified click is the browser\'s: it does not open the pane', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const marker = markerFor(testInfo.workerIndex);
    const { first } = await seedTrio(apiAsAdmin, marker);

    await page.goto(`/search?q=${marker}`);
    const row = resultLink(page, first.title);
    await expect(row).toBeVisible();
    // Still a real link, so a new tab or a copied link lands on the item.
    await expect(row).toHaveAttribute('href', `/p/${first.slug}`);

    const popup = page.context().waitForEvent('page', { timeout: 5_000 }).catch(() => null);
    await row.click({ modifiers: ['ControlOrMeta'] });
    (await popup)?.close();

    await expect(page).toHaveURL(NO_PEEK);
    await expect(page).toHaveURL(/\/search\?/);
    await expect(pane(page)).toHaveCount(0);
  });

  test('a wiki link inside the pane opens its target in the same pane, and Back returns to the article', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const marker = markerFor(testInfo.workerIndex);
    const { second, target } = await seedTrio(apiAsAdmin, marker);

    await page.goto(`/search?q=${marker}`);
    await resultLink(page, second.title).click();
    await expect(page.getByRole('complementary', { name: `Reading pane: ${second.title}` })).toBeVisible();

    await pane(page).locator('.kp-read-view').getByRole('link', { name: target.title }).click();
    await expect(page).toHaveURL(peekIs(target.slug));
    await expect(page).toHaveURL(/\/search\?/);
    await expect(page.getByRole('complementary', { name: `Reading pane: ${target.title}` })).toBeVisible();
    await expect(page.locator('#reading-pane-title')).toHaveText(target.title);
    await expect(page.locator('#reading-pane-title')).toBeFocused();
    await expect(page.locator('main.Search')).toBeVisible();

    // Reading onward pushes: Back is the article the link was in.
    await page.goBack();
    await expect(page).toHaveURL(peekIs(second.slug));
    await expect(page.getByRole('complementary', { name: `Reading pane: ${second.title}` })).toBeVisible();
  });

  test('home: an Updates story opens in the pane', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const marker = markerFor(testInfo.workerIndex);
    const tag = `rpnews-${marker}`;
    const beforeRes = await apiAsAdmin.get('/api/v1/sections');
    if (!beforeRes.ok()) throw new Error(`list sections failed: ${beforeRes.status()}`);
    const before = ((await beforeRes.json()).sections ?? []) as Record<string, unknown>[];

    const lead = await createPageViaApi(apiAsAdmin, {
      title: `Pane Lead ${marker}`,
      body: 'The newest story.',
      status: 'published',
      tags: [tag],
      frontmatter: { type: 'Blog Post', topic: 'default', published_at: '2026-09-02T00:00:00.000Z' },
    });
    const row = await createPageViaApi(apiAsAdmin, {
      title: `Pane Row ${marker}`,
      body: 'An older story.',
      status: 'published',
      tags: [tag],
      frontmatter: { type: 'Blog Post', topic: 'default', published_at: '2026-09-01T00:00:00.000Z' },
    });
    const put = await apiAsAdmin.put('/api/v1/sections', {
      data: { sections: [{ name: `Pane news ${marker}`, slug: `rp-news-${marker}`, tags: [tag], order: 0, limit: 12 }] },
    });
    if (!put.ok()) throw new Error(`save sections failed: ${put.status()} ${await put.text()}`);

    try {
      await page.goto('/');
      const home = page.locator('main.Home');
      const leadLink = home.getByTestId('home-lead').getByRole('link', { name: `Pane Lead ${marker}` });
      const rowLink = home.getByTestId('home-row').getByRole('link', { name: `Pane Row ${marker}` });
      await expect(leadLink).toBeVisible();

      // Eric, 2026-09-13: the pane takes roughly half the space; Updates stays
      // centred in the other half at (about) the width it had with the pane closed.
      const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
      const feedClosed = await box('.Home__feed');

      await leadLink.click();
      await expect(page).toHaveURL(peekIs(lead.slug));
      await expect(page.getByRole('complementary', { name: `Reading pane: Pane Lead ${marker}` })).toBeVisible();
      await expect(home).toBeVisible();

      const list = await box('.kp-reading-layout > :first-child');
      const paneBox = await box('.kp-reading-pane');
      const feedOpen = await box('.Home__feed');
      expect(Math.abs(paneBox.width - list.width), 'the pane is half the space').toBeLessThanOrEqual(2);
      const leftGap = feedOpen.x - list.x;
      const rightGap = list.x + list.width - (feedOpen.x + feedOpen.width);
      expect(Math.abs(leftGap - rightGap), `Updates is centred in its half (${leftGap} vs ${rightGap})`).toBeLessThanOrEqual(20);
      // Updates keeps its closed width, unless the half is too narrow for it
      // (a 1920px screen with no Popular column), and then it fills the half
      // less its gutters. Never wider than when closed.
      expect(feedOpen.width).toBeLessThanOrEqual(feedClosed.width + 2);
      expect(feedOpen.width).toBeGreaterThanOrEqual(Math.min(feedClosed.width, list.width - 2 * 48) - 2);
      await expect(leadLink).toHaveAttribute('aria-current', 'true');
      await expect(page.locator('#reading-pane-title')).toBeFocused();

      await rowLink.click();
      await expect(page).toHaveURL(peekIs(row.slug));
      await expect(rowLink).toHaveAttribute('aria-current', 'true');

      await page.keyboard.press('Escape');
      await expect(pane(page)).toHaveCount(0);
      await expect(rowLink).toBeFocused();
      // Closed again: back to the centred page at its original width.
      const feedReclosed = await box('.Home__feed');
      expect(Math.abs(feedReclosed.width - feedClosed.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(feedReclosed.x - feedClosed.x)).toBeLessThanOrEqual(2);

      // Topic links on a story's metadata line still go to the topic.
      await expect(home.getByTestId('home-topic').first()).toHaveAttribute('href', /^\/topics\//);
    } finally {
      await apiAsAdmin.put('/api/v1/sections', { data: { sections: before } });
    }
  });
});

test.describe('below the threshold nothing changes', () => {
  test.use({ viewport: NARROW });

  test('a click navigates to the item page, with no pane', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const marker = markerFor(testInfo.workerIndex);
    const { first } = await seedTrio(apiAsAdmin, marker);

    await page.goto(`/search?q=${marker}`);
    const row = resultLink(page, first.title);
    await expect(row).toBeVisible();
    await expect(page.locator('[data-reading-layout]')).toHaveCount(0);
    await expect(row).not.toHaveAttribute('aria-current', /.*/);

    await row.click();
    await expect(page).toHaveURL(new RegExp(`/p/${escapeRegExp(first.slug)}$`));
    await expect(pane(page)).toHaveCount(0);
  });

  test('a ?peek link lands on the item page instead', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const marker = markerFor(testInfo.workerIndex);
    const { first } = await seedTrio(apiAsAdmin, marker);

    await page.goto(`/search?q=x&peek=${first.slug}`);
    await expect(page).toHaveURL(new RegExp(`/p/${escapeRegExp(first.slug)}$`));
    await expect(pane(page)).toHaveCount(0);
  });
});
