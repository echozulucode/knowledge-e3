import { test, expect, createPageViaApi, createUserApiContext } from './fixtures.js';
import type { APIRequestContext, Browser, Locator, Page } from '@playwright/test';

/**
 * The front page (features/18-home-page.feature; the home prototype plan,
 * cut over 2026-09-12).
 *
 * Two things shape every assertion in this file.
 *
 * **The default reader is anonymous.** `readAccess.default` is `public` and a
 * topic's `visibility` defaults to `public`, so the common case for a front page
 * on this product is a visitor who is not signed in. Everything user-visible is
 * therefore checked from a genuinely separate browser context — `browser.newContext()`,
 * never the `page` fixture, because `signedInPage` is built FROM `page` and
 * destructuring both hands you the same authenticated browser twice (issue 112),
 * which makes an "anonymous" assertion pass while asserting nothing.
 *
 * **There is one home page.** `/` renders it, `KickoffHome`, the editorial hero,
 * `?v=next` and `/home-next` are gone, and this product has never been used for
 * real, so nothing redirects and nothing is aliased. The root element is
 * `main.Home`, which is the locator the rest of the suite already uses.
 */

/** A tiny valid 1x1 PNG, the same bytes the server's image tests use. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function getSections(api: APIRequestContext): Promise<Record<string, unknown>[]> {
  const res = await api.get('/api/v1/sections');
  if (!res.ok()) throw new Error(`list sections failed: ${res.status()}`);
  return ((await res.json()).sections ?? []) as Record<string, unknown>[];
}

async function putSections(api: APIRequestContext, sections: Record<string, unknown>[]) {
  const res = await api.put('/api/v1/sections', { data: { sections } });
  if (!res.ok()) throw new Error(`save sections failed: ${res.status()} ${await res.text()}`);
}

async function getPins(api: APIRequestContext): Promise<Record<string, unknown>[]> {
  const res = await api.get('/api/v1/site/pinned');
  if (!res.ok()) throw new Error(`list pins failed: ${res.status()}`);
  return ((await res.json()).pinned ?? []) as Record<string, unknown>[];
}

async function putPins(api: APIRequestContext, pinned: Record<string, unknown>[]) {
  const res = await api.put('/api/v1/site/pinned', { data: { pinned } });
  if (!res.ok()) throw new Error(`save pins failed: ${res.status()} ${await res.text()}`);
}

/** Restore whatever the pin list looked like, as the curator's own definitions. */
function pinDefs(pins: Record<string, unknown>[]): Record<string, unknown>[] {
  return pins.map((p) => ({
    topic: p['topic'],
    ...(p['color'] ? { color: p['color'] } : {}),
    ...(p['icon'] ? { icon: p['icon'] } : {}),
    ...(p['cover'] ? { cover: p['cover'] } : {}),
    ...(p['cover'] && p['cover_dark'] ? { cover_dark: p['cover_dark'] } : {}),
  }));
}

async function makeTopic(api: APIRequestContext, slug: string, extra: Record<string, unknown> = {}) {
  const res = await api.post('/api/v1/topics', { data: { name: slug, slug, ...extra } });
  if (!res.ok() && res.status() !== 409) throw new Error(`seed topic failed: ${res.status()} ${await res.text()}`);
}

/**
 * Upload a fresh image and return its `/assets/` URL.
 *
 * Every cover assertion in this file owns its bytes (home plan R2.5): the
 * seeded covers are generated art that is regenerated whenever the seed's
 * motifs change, and a test that reads them would be testing the seed, not the
 * page's promise that a cover loads for somebody who is not signed in.
 */
async function uploadCover(api: APIRequestContext): Promise<string> {
  const upload = await api.post('/api/v1/images', {
    headers: { 'content-type': 'image/png' },
    data: PNG,
  });
  if (!upload.ok()) throw new Error(`upload failed: ${upload.status()} ${await upload.text()}`);
  return (await upload.json()).url as string;
}

/**
 * Wait until an `<img>` has actually decoded — `naturalWidth > 0` — rather than
 * merely existing. An image the server refuses still produces an `<img>` tag,
 * which is exactly why a tag assertion proves nothing about an anonymous
 * visitor. Covers are `loading="lazy"`, so the element is brought into view
 * first.
 */
async function expectImageLoaded(img: Locator) {
  await img.scrollIntoViewIfNeeded();
  await expect
    .poll(() => img.evaluate((el) => ((el as HTMLImageElement).complete ? (el as HTMLImageElement).naturalWidth : 0)), {
      message: 'the image must decode for this visitor',
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
}

/** A browser that has never signed in. Never derive this from the `page` fixture. */
async function anonymous(browser: Browser, origin: string) {
  return browser.newContext({ baseURL: origin });
}

/**
 * How many of these elements share the topmost row — i.e. the column count the
 * intrinsic grid resolved to at the current width. Measured from the rendered
 * boxes rather than read out of the CSS, because what is under test is the
 * layout the browser produced, not the declaration that asked for it.
 */
async function columnCount(locator: Locator): Promise<number> {
  const tops = await locator.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
  if (tops.length === 0) return 0;
  const first = Math.min(...tops);
  return tops.filter((t) => Math.abs(t - first) < 2).length;
}

/** A topic's display name, as the Updates feed labels its stories with it. */
async function topicName(api: APIRequestContext, slug: string): Promise<string> {
  const list = await api.get('/api/v1/topics');
  if (!list.ok()) throw new Error(`list topics failed: ${list.status()}`);
  const body = await list.json();
  const topics = (Array.isArray(body) ? body : (body.topics ?? body.items ?? [])) as Record<string, unknown>[];
  const topic = topics.find((t) => t['slug'] === slug);
  if (!topic) throw new Error(`no topic ${slug}`);
  return String(topic['name']);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The page's own scroll container is `main.Home`; this is its overflow state. */
async function scrollState(page: Page): Promise<{ scrollable: boolean; overflowsHorizontally: boolean }> {
  return page.locator('main.Home').evaluate((el) => ({
    scrollable: el.scrollHeight > el.clientHeight + 1,
    overflowsHorizontally: el.scrollWidth > el.clientWidth + 1,
  }));
}

test.describe('the front page', () => {
  test('/ renders it, and the prototype doors are gone', async ({ signedInPage }) => {
    await signedInPage.goto('/');
    const home = signedInPage.locator('main.Home');
    await expect(home).toBeVisible();

    // The prototype's shareable door is a 404-shaped nothing now: no redirect,
    // no alias. This product has never been used for real, so there is no link
    // anywhere that could still point here.
    await signedInPage.goto('/home-next');
    await expect(signedInPage.locator('main.Home')).toHaveCount(0);

    // And the query switch is inert — `/` renders the same page either way.
    await signedInPage.goto('/?v=classic');
    await expect(signedInPage.locator('main.Home')).toBeVisible();
    await expect(signedInPage.getByRole('link', { name: 'Classic home' })).toHaveCount(0);
  });

  test('the wordmark and both taglines are off the page, and the attribution is at the bottom', async ({ signedInPage, browser }) => {
    await signedInPage.goto('/');
    const home = signedInPage.locator('main.Home');
    await expect(home).toBeVisible();

    // The two taglines Eric named: the editorial branch's hard-coded headline
    // and SITE_DEFAULTS.tagline, which the portal branch rendered as its <h1>.
    await expect(home.getByText('Quiet, source-backed knowledge.')).toHaveCount(0);
    await expect(home.getByText('What do you want to do with AI?')).toHaveCount(0);
    // And the eyebrow that put the product's storage architecture in the first
    // line of a tenant's front page.
    await expect(home.getByText('OKF/Git-backed')).toHaveCount(0);
    // Nor the CMS stat panel.
    await expect(home.getByText('Workspace pulse')).toHaveCount(0);

    // Ours moves to the colophon — subtle, present, and unconditional, because
    // the attribution is not the tenant's name and does not follow it.
    const footer = home.locator('.SiteFooter');
    await expect(footer).toContainText('Powered by Knowledge');
    await expect(footer.locator('sup')).toHaveText('3');

    // The anonymous visitor — the default reader — gets the same page.
    const ctx = await anonymous(browser, new URL(signedInPage.url()).origin);
    try {
      const anon = await ctx.newPage();
      await anon.goto('/');
      await expect(anon.locator('main.Home .SiteFooter')).toContainText('Powered by Knowledge');
      await expect(anon.locator('main.Home').getByText('What do you want to do with AI?')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  /**
   * Eric: "the 'Powered by' should be at the bottom … it should be flush against
   * the bottom if there isn't enough content to fill."
   *
   * Both halves of that sentence, measured. The mechanism is `margin-top: auto`
   * inside a page the shell has already stretched to the content area's height
   * (Home.css), so the test that would catch a regression is a comparison of the
   * footer's bottom edge with the viewport's — not a class assertion.
   */
  test('the colophon is flush against the bottom of a short page and follows a long one', async ({ browser, signedInPage }) => {
    const ctx = await anonymous(browser, new URL(signedInPage.url()).origin);
    try {
      const anon = await ctx.newPage();

      // A viewport taller than this instance's front page: the content cannot
      // fill it, so the footer must sit on the bottom edge rather than floating
      // under the last block with empty page beneath it.
      await anon.setViewportSize({ width: 1280, height: 1800 });
      await anon.goto('/');
      await expect(anon.locator('main.Home .SiteFooter')).toBeVisible();
      expect((await scrollState(anon)).scrollable, 'the page must be short at 1800px tall for this to mean anything').toBe(false);

      const footer = await anon.locator('main.Home .SiteFooter').boundingBox();
      const viewport = anon.viewportSize()!;
      expect(footer, 'the colophon must be laid out').not.toBeNull();
      expect(Math.abs(footer!.y + footer!.height - viewport.height)).toBeLessThanOrEqual(2);

      // The last block above it is NOT dragged down with it: the free space goes
      // between the content and the footer, which is what `margin-top: auto`
      // means and what distinguishes it from a footer pinned with `position`.
      const lastBlock = await anon.locator('main.Home > *').nth(-2).boundingBox();
      expect(lastBlock!.y + lastBlock!.height).toBeLessThan(footer!.y - 1);

      // And on a short viewport the same page is taller than the screen, so the
      // colophon is simply the last thing you scroll to — never overlaying the
      // content, never repeated.
      await anon.setViewportSize({ width: 1280, height: 700 });
      expect((await scrollState(anon)).scrollable).toBe(true);
      const offscreen = await anon.locator('main.Home .SiteFooter').boundingBox();
      expect(offscreen!.y).toBeGreaterThan(700);
      await anon.locator('main.Home .SiteFooter').scrollIntoViewIfNeeded();
      await expect(anon.locator('main.Home .SiteFooter')).toBeInViewport();
    } finally {
      await ctx.close();
    }
  });

  /**
   * Eric: "Make sure you're using space wisely for multiple screens and maximize
   * space utilization for both small and large screen via proven methods."
   *
   * Five real widths, measured rather than eyeballed. The layout carries no
   * media query at all — the arrangement follows container queries on the
   * page's own content width, and `repeat(auto-fill, minmax(…, 1fr))` inside
   * each region — so what these assertions pin down is that those rules resolve
   * to the intended arrangement at each end of the range.
   *
   * Revision 2 (R2.2) changed two of the shapes on purpose: the Updates feed is
   * a vertical LIST at every width (a grid of narrow cards is what truncated
   * every title), and the pins are ONE column while they sit beside the feed
   * and a grid only once they have wrapped under it. Eric's second round made
   * the pins a chip strip ABOVE the feed on a phone; the strip itself is the
   * next test.
   */
  test('the layout reflows by content width, from 360 to 2560', async ({ browser, signedInPage }) => {
    const ctx = await anonymous(browser, new URL(signedInPage.url()).origin);
    try {
      const anon = await ctx.newPage();
      const rows = anon.getByTestId('home-row');
      const pins = anon.getByTestId('home-pin');
      const feed = anon.locator('.Home__feedCol');

      const at = async (width: number, height = 900) => {
        await anon.setViewportSize({ width, height });
        await anon.goto('/');
        await expect(anon.locator('main.Home')).toBeVisible();
        await expect(rows.first()).toBeVisible();
        await expect(pins.first()).toBeVisible();
        return {
          rows: await columnCount(rows),
          pins: await columnCount(pins),
          feed: (await feed.boundingBox())!,
          firstPin: (await pins.first().boundingBox())!,
          overflow: (await scrollState(anon)).overflowsHorizontally,
        };
      };

      // A phone. One column, the pins ABOVE the feed as a strip of chips side by
      // side, and — the assertion that actually catches bugs — nothing at all
      // sticking out sideways.
      const small = await at(360);
      expect(small.overflow, 'nothing may overflow horizontally at 360px').toBe(false);
      expect(small.rows).toBe(1);
      expect(small.pins, 'the pins are one row of chips on a phone').toBeGreaterThanOrEqual(2);
      expect(small.firstPin.y + small.firstPin.height).toBeLessThanOrEqual(small.feed.y);

      // A tablet. The pins have wrapped under the feed and, being full width
      // there, their own grid has gained a column rather than leaving a stripe
      // of empty page beside them.
      const tablet = await at(768);
      expect(tablet.overflow).toBe(false);
      expect(tablet.firstPin.y).toBeGreaterThan(tablet.feed.y);
      expect(tablet.pins).toBeGreaterThanOrEqual(2);

      // A laptop. Both regions now fit on one line, so the pins move beside the
      // feed — with no breakpoint having been crossed, only room found — and,
      // beside it, they are a single column.
      const laptop = await at(1024);
      expect(laptop.overflow).toBe(false);
      expect(laptop.firstPin.x).toBeGreaterThan(laptop.feed.x + laptop.feed.width - 1);
      expect(laptop.pins, 'pins beside the feed are one column').toBe(1);
      expect(laptop.rows, 'the Updates feed is a list').toBe(1);

      // A desktop.
      const desktop = await at(1440);
      expect(desktop.overflow).toBe(false);
      expect(desktop.firstPin.x).toBeGreaterThan(desktop.feed.x + desktop.feed.width - 1);
      expect(desktop.feed.width).toBeGreaterThan(laptop.feed.width);
      expect(desktop.pins).toBe(1);

      // A large monitor. The feed stays a list — every title gets the column's
      // width — and the feed column, not the pin column, takes the extra room.
      // (Whether a third, Popular column sits beside them depends on whether
      // anyone has read anything yet; none of these assertions depend on it.)
      const wide = await at(2560, 1440);
      expect(wide.overflow).toBe(false);
      expect(wide.rows, 'the Updates feed is a list at every width').toBe(1);
      expect(wide.pins, 'pins beside the feed stay one column on a wide screen').toBe(1);
      expect(wide.firstPin.x).toBeGreaterThan(wide.feed.x + wide.feed.width - 1);
      expect(wide.feed.width).toBeGreaterThan(wide.firstPin.width * 2);

      // The content cap: past `--kp-home-max` (= `--kp-page-width-wide`, 96rem =
      // 1536px; page-widths.spec.ts checks every page's cap) the extra width
      // is gutter, so the two columns together never span the monitor.
      const top = await anon.locator('.Home__top').boundingBox();
      expect(top!.width).toBeLessThanOrEqual(1536 + 1);

      // Prose does not get wider, it gets company: the lead card's brief keeps
      // its reading measure while the layout around it takes the width.
      const preview = await anon.locator('.Home__lead .kp-item-card__preview').boundingBox();
      expect(preview!.width).toBeLessThan(900);
    } finally {
      await ctx.close();
    }
  });

  /**
   * Eric: "what is the appropriate display for … mobile". On a phone the key
   * topics are the page's navigation, so they come first — as ONE line of
   * compact chips that scrolls sideways inside itself, never as four
   * full-width cards pushing the first story a screen down, and never by making
   * the page itself scroll sideways.
   */
  test('on a phone the key topics are a chip strip above Updates, and the page never scrolls sideways', async ({ browser, signedInPage }) => {
    const ctx = await browser.newContext({ baseURL: new URL(signedInPage.url()).origin, viewport: { width: 390, height: 844 } });
    try {
      const anon = await ctx.newPage();
      await anon.goto('/');
      const home = anon.locator('main.Home');
      const pins = home.getByTestId('home-pin');
      await expect(home.getByTestId('home-lead')).toBeVisible();
      await expect(pins.first()).toBeVisible();
      // The seed pins four topics; a strip needs more chips than fit to scroll.
      expect(await pins.count()).toBeGreaterThanOrEqual(3);

      // Above Updates.
      const strip = home.locator('.Home__pinGrid');
      const stripBox = (await strip.boundingBox())!;
      const feedBox = (await home.locator('.Home__feedCol').boundingBox())!;
      expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(feedBox.y);

      // One row of chips, each a thumbnail and a name — no description.
      expect(await columnCount(pins)).toBe(await pins.count());
      await expect(pins.first().locator('.kp-pin__desc')).toBeHidden();
      const chip = (await pins.first().boundingBox())!;
      expect(chip.height, 'a chip is compact, not a card').toBeLessThan(90);

      // It scrolls sideways, inside itself — and the partly visible next chip
      // is the affordance that says so.
      const scroll = await strip.evaluate((el) => {
        const before = { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
        el.scrollLeft = 120;
        return { ...before, scrolledTo: el.scrollLeft, overflowX: getComputedStyle(el).overflowX };
      });
      expect(scroll.overflowX).toBe('auto');
      expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
      expect(scroll.scrolledTo).toBeGreaterThan(0);
      await strip.evaluate((el) => {
        el.scrollLeft = 0;
      });
      const secondOrThird = await pins.evaluateAll((els, width) => els.some((el) => {
        const r = el.getBoundingClientRect();
        return r.left < width && r.right > width;
      }), stripBox.x + stripBox.width);
      expect(secondOrThird, 'a chip must be cut off at the strip edge').toBe(true);

      // Every chip is reachable from the keyboard, and focusing an off-screen
      // one brings it into view.
      const lastLink = pins.last().getByRole('link');
      await lastLink.focus();
      await expect(lastLink).toBeFocused();
      await expect(pins.last()).toBeInViewport();

      // The page itself never scrolls sideways — the document or its scroll
      // container.
      const widths = await anon.evaluate(() => ({ doc: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(widths.doc).toBeLessThanOrEqual(widths.inner);
      expect((await scrollState(anon)).overflowsHorizontally).toBe(false);

      // Popular, when anybody has read anything, comes after the feed.
      const popular = home.getByTestId('home-popular');
      if (await popular.count()) {
        expect((await popular.boundingBox())!.y).toBeGreaterThan(feedBox.y + feedBox.height - 1);
      }
    } finally {
      await ctx.close();
    }
  });

  /**
   * Eric: "what is the appropriate display for ultrawide". The content stays
   * capped and centred; the width inside the cap buys a third, narrow column —
   * site-wide Popular — rather than longer lines. Views are seeded the way a
   * reader produces them: `POST /events/page-view` from signed-in sessions.
   */
  test('on an ultrawide screen Popular is a third column beside Updates and the key topics', async ({ browser, signedInPage, apiAsAdmin, playwright }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const read = await createPageViaApi(apiAsAdmin, {
      title: `Popular Read ${suffix}`,
      body: 'Somebody read this.',
      status: 'published',
      frontmatter: { type: 'Concept', topic: 'default' },
    });
    const reader = await createUserApiContext(playwright, apiAsAdmin, { username: `popreader${testInfo.workerIndex}` });
    try {
      for (const api of [apiAsAdmin, reader]) {
        const view = await api.post('/api/v1/events/page-view', { data: { page_id: read.id } });
        expect(view.status(), 'recording a page view').toBe(204);
      }
    } finally {
      await reader.dispose();
    }

    const ctx = await browser.newContext({ baseURL: new URL(signedInPage.url()).origin, viewport: { width: 2560, height: 1300 } });
    try {
      const anon = await ctx.newPage();
      await anon.goto('/');
      const home = anon.locator('main.Home');
      const popular = home.getByTestId('home-popular');
      await expect(home.getByTestId('home-lead')).toBeVisible();
      await expect(home.getByTestId('home-pin').first()).toBeVisible();
      await expect(popular, 'Popular must render once somebody has read something').toBeVisible();
      await expect(popular.getByTestId('home-popular-item').first()).toContainText(/\d+ readers?/);

      const feed = (await home.locator('.Home__feedCol').boundingBox())!;
      const pins = (await home.locator('.Home__pins').boundingBox())!;
      const side = (await home.locator('.Home__side').boundingBox())!;
      // Side by side, in that order, on one row.
      expect(pins.x).toBeGreaterThanOrEqual(feed.x + feed.width - 1);
      expect(side.x).toBeGreaterThanOrEqual(pins.x + pins.width - 1);
      expect(Math.abs(pins.y - feed.y)).toBeLessThan(2);
      expect(Math.abs(side.y - feed.y)).toBeLessThan(2);
      // Updates is the widest, and all three together stay inside the cap.
      expect(feed.width).toBeGreaterThan(pins.width * 2);
      expect(feed.width).toBeGreaterThan(side.width * 2);
      const top = (await home.locator('.Home__top').boundingBox())!;
      expect(top.width).toBeLessThanOrEqual(1536 + 1);

      // Narrower than three columns fit, Popular moves under the key topics,
      // still beside the feed.
      await anon.setViewportSize({ width: 1280, height: 900 });
      await expect(popular).toBeVisible();
      const feed2 = (await home.locator('.Home__feedCol').boundingBox())!;
      const pins2 = (await home.locator('.Home__pins').boundingBox())!;
      const popular2 = (await popular.boundingBox())!;
      expect(pins2.x).toBeGreaterThanOrEqual(feed2.x + feed2.width - 1);
      expect(Math.abs(popular2.x - pins2.x)).toBeLessThan(2);
      expect(popular2.y).toBeGreaterThanOrEqual(pins2.y + pins2.height - 1);
      expect((await scrollState(anon)).overflowsHorizontally).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  test('the Updates feed is the tenant-tagged cross-topic Section, newest first and capped', async ({ signedInPage, browser, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const tag = `hnnews-${suffix}`;
    const before = await getSections(apiAsAdmin);

    // Eight tagged posts, created out of date order so the assertion proves the
    // configured sort rather than insertion order.
    const months = ['01', '02', '03', '04', '05', '06', '07', '08'];
    for (const m of [...months].reverse()) {
      await createPageViaApi(apiAsAdmin, {
        title: `HN Story ${m} ${suffix}`,
        body: `Story from month ${m}.`,
        status: 'published',
        tags: [tag],
        frontmatter: { type: 'Blog Post', topic: 'default', published_at: `2026-${m}-01T00:00:00.000Z` },
      });
    }
    // Same topic and type, untagged: the feed is tag-driven, not "the newest
    // Blog Posts".
    await createPageViaApi(apiAsAdmin, {
      title: `HN Untagged ${suffix}`,
      body: 'Not news.',
      status: 'published',
      frontmatter: { type: 'Blog Post', topic: 'default', published_at: '2026-12-01T00:00:00.000Z' },
    });

    // The exact configuration a tenant writes — and the exact shape `just seed`
    // now writes on a fresh instance: no topic (that is what makes it
    // cross-topic), the tags they use, order 0 so it leads.
    await putSections(apiAsAdmin, [
      { name: `Company news ${suffix}`, slug: `hn-news-${suffix}`, tags: [tag], order: 0, limit: 12 },
    ]);

    try {
      const ctx = await anonymous(browser, new URL(signedInPage.url()).origin);
      try {
        const anon = await ctx.newPage();
        await anon.goto('/');
        const home = anon.locator('main.Home');

        // The heading is the SECTION'S OWN NAME, not a literal: a tenant who
        // calls it "Announcements" must get the same layout.
        await expect(home.getByRole('heading', { name: `Company news ${suffix}` })).toBeVisible();

        // Recency, not curation: the newest item leads, as a card.
        const lead = home.getByTestId('home-lead');
        await expect(lead.getByRole('link', { name: `HN Story 08 ${suffix}` })).toBeVisible();

        // Five rows under it, newest first, capped at six items in total even
        // though the Section resolves twelve.
        const rows = home.getByTestId('home-row');
        await expect(rows).toHaveCount(5);
        await expect(rows.locator('a', { hasText: 'HN Story' })).toHaveText([
          `HN Story 07 ${suffix}`,
          `HN Story 06 ${suffix}`,
          `HN Story 05 ${suffix}`,
          `HN Story 04 ${suffix}`,
          `HN Story 03 ${suffix}`,
        ]);

        // One metadata line per story instead of a row of chips (R2.4): the
        // kind, the date and the reading time. The content type is text here;
        // its badge stays on the reading page. And an unverified item - all of
        // these - carries no trust signal at all on an index surface.
        const feed = home.locator('.Home__feed');
        await expect(rows.first().locator('.kp-item-meta')).toContainText('Blog Post');
        await expect(rows.first().locator('.kp-item-meta')).toContainText('min read');
        // The feed is cross-topic, so each story names its topic — first on
        // the line: `Topic · Blog Post · date · N min read`.
        const defaultName = await topicName(apiAsAdmin, 'default');
        await expect(rows.first().locator('.kp-item-meta')).toHaveText(
          new RegExp(`^${escapeRegExp(defaultName)}\\s*·\\s*Blog Post\\s*·`),
        );
        await expect(lead.locator('.kp-item-meta')).toHaveText(new RegExp(`^${escapeRegExp(defaultName)}\\s*·`));
        await expect(feed.locator('.kp-type-badge')).toHaveCount(0);
        await expect(feed.getByText('Unverified')).toHaveCount(0);
        await expect(feed.locator('.kp-trust-mark')).toHaveCount(0);

        // The untagged item is not an update, and the rest of THIS feed is one
        // click away - on the Section's own page, not `/latest`, which is every
        // published item and a different list (R2.0).
        await expect(home.getByRole('link', { name: `HN Untagged ${suffix}` })).toHaveCount(0);
        const more = feed.getByRole('link', { name: /^View all updates/ });
        await expect(more).toBeVisible();
        await expect(more).toHaveAttribute('href', `/sections/hn-news-${suffix}`);
        await expect(home.getByRole('link', { name: /^Latest/ })).toHaveCount(0);

        // A reader never sees setup instructions.
        await expect(home.getByRole('link', { name: 'Curate an updates feed' })).toHaveCount(0);

        // The topic label is its own link, above the row's stretched title
        // overlay, and goes to the topic rather than the story.
        const topicLink = rows.first().getByTestId('home-topic');
        await expect(topicLink).toHaveAttribute('href', '/topics/default');
        await topicLink.click();
        await expect(anon).toHaveURL(/\/topics\/default$/);
        await anon.goto('/');

        // The feed reaches its item.
        await lead.getByRole('link', { name: `HN Story 08 ${suffix}` }).click();
        await expect(anon).toHaveURL(/\/p\//);
      } finally {
        await ctx.close();
      }
    } finally {
      await putSections(apiAsAdmin, before);
    }
  });

  /**
   * The state `just seed` leaves behind, asserted as the product of the seed
   * rather than of this test: an Updates Section nobody configured by hand,
   * stories in more than one topic, and pinned topics with colours.
   *
   * It deliberately does NOT read the seeded cover bytes. The seed's covers are
   * generated art and are regenerated when its motifs change; whether a cover
   * loads for an anonymous visitor is asserted against fixtures the tests upload
   * themselves (the pinned-topics and Updates-cover tests below).
   *
   * This is the "populate the home page accordingly" requirement, and it belongs
   * in the browser because "the seed wrote a row" is not the claim — the claim is
   * that a fresh instance's front page demonstrates the design.
   */
  test('a freshly seeded instance shows a populated front page', async ({ browser, signedInPage, apiAsAdmin }) => {
    // Nothing in this test writes; it reads what the seed already did. If an
    // earlier test had left the instance reconfigured, this would be worth
    // nothing, so it asserts the seeded shapes explicitly.
    const sections = await getSections(apiAsAdmin);
    // Renamed from News at Eric's request (R2.1): the Section is `Updates`, and
    // the tag an author types is `update` — the word the reader sees above it.
    const updates = sections.find((s) => s['slug'] === 'updates');
    expect(updates, 'the seed must configure an Updates section').toBeTruthy();
    expect(updates!['name']).toBe('Updates');
    expect(updates!['space'], 'the Updates section must name no topic — that is what makes it cross-topic').toBeUndefined();
    expect(updates!['tags']).toEqual(['update']);

    const ctx = await anonymous(browser, new URL(signedInPage.url()).origin);
    try {
      const anon = await ctx.newPage();
      await anon.goto('/');
      const home = anon.locator('main.Home');

      await expect(home.getByRole('heading', { name: 'Updates', exact: true })).toBeVisible();
      await expect(home.getByRole('link', { name: /^View all updates/ })).toHaveAttribute('href', '/sections/updates');
      await expect(home.getByTestId('home-lead')).toContainText('Knowledge Hub is open to every team');
      // Newest first, visibly: the seeded dates descend down the feed, and the
      // oldest story is off the bottom of it because the first screen shows six
      // items while the Section resolves twelve.
      const rows = home.getByTestId('home-row');
      await expect(rows).toHaveCount(5);
      await expect(rows.locator('.kp-item-row__title')).toHaveText([
        'Search is 38% faster after the index rebuild',
        'New runbook: restoring a topic from the git mirror',
        'What 24 interviews told us about how people search',
        'Private topics now default to closed',
        'Architecture: one canonical file per item',
      ]);

      // The cross-topic property, from the page: the lead is in one topic and
      // the last row in another, so this feed could not have come from a single
      // topic's landing page.
      await rows.last().getByRole('link').first().click();
      await expect(anon.getByRole('heading', { level: 1, name: 'Architecture: one canonical file per item' })).toBeVisible();

      await anon.goto('/');
      const pins = home.getByTestId('home-pin');
      await expect(pins).toHaveCount(4);
      await expect(pins.nth(0)).toHaveAttribute('data-pin-color', 'teal');
      await expect(pins.nth(0)).toContainText('Product workspace');
      // Every card has the same thumbnail slot; a fresh instance shows both of
      // its states — a cover on some pins, the topic's icon on the rest (R2.5).
      await expect(home.locator('.kp-pin__thumb[data-thumb="cover"]').first()).toBeVisible();
      await expect(home.locator('.kp-pin__thumb[data-thumb="icon"]').first()).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test('an unconfigured instance looks like a page, not a broken one', async ({ signedInPage, browser, apiAsAdmin }) => {
    // The three things a brand-new tenant has not set: `site.homeTopic` (this
    // instance has no `site:` block at all), no pinned topic, and nothing
    // tagged as an update.
    const beforeSections = await getSections(apiAsAdmin);
    const beforePins = await getPins(apiAsAdmin);
    await putSections(apiAsAdmin, []);
    await putPins(apiAsAdmin, []);

    try {
      const ctx = await anonymous(browser, new URL(signedInPage.url()).origin);
      try {
        const anon = await ctx.newPage();
        await anon.goto('/');
        const home = anon.locator('main.Home');
        await expect(home).toBeVisible();

        // Nothing is tagged yet, so the page shows the site-wide recent feed in
        // the SHAPE of the finished page — under a heading that does not claim
        // curation nobody has done.
        await expect(home.getByRole('heading', { name: 'Recently published' })).toBeVisible();
        await expect(home.getByTestId('home-lead')).toBeVisible();
        // Its "more" link is honest about the list it opens: the site-wide
        // recent feed, not an Updates Section nobody configured.
        await expect(home.getByRole('link', { name: /^View all updates/ })).toHaveCount(0);
        await expect(home.getByRole('link', { name: /^View all recently published/ })).toHaveAttribute('href', '/latest');

        // No pins: the right column does not render at all and the feed goes
        // full width.
        await expect(home.locator('.Home__top')).toHaveAttribute('data-pins', 'no');
        await expect(home.getByRole('complementary', { name: 'Key topics' })).toHaveCount(0);

        // The colophon is still there, so the page is a page.
        await expect(home.locator('.SiteFooter')).toBeVisible();
      } finally {
        await ctx.close();
      }

      // The one person who can fix it is told how, quietly, and only them.
      await signedInPage.goto('/');
      const hint = signedInPage.locator('main.Home').getByRole('link', { name: 'Curate an updates feed' });
      await expect(hint).toBeVisible();
      await hint.click();
      await expect(signedInPage).toHaveURL(/\/admin\/sections$/);
    } finally {
      await putSections(apiAsAdmin, beforeSections);
      await putPins(apiAsAdmin, pinDefs(beforePins));
    }
  });

  /**
   * Search lives in the header on every screen and on `/search`; the front page
   * no longer carries a field of its own (Eric, second round). A second door to
   * the same index was the thing the first design review called confusing, and
   * the most prominent thing on a front page should be what the tenant
   * published. `All topics →` stays, under the key topics.
   */
  test('the front page has no search field of its own, and All topics stays under the key topics', async ({ signedInPage }) => {
    await signedInPage.goto('/');
    const home = signedInPage.locator('main.Home');
    await expect(home.getByTestId('home-lead')).toBeVisible();
    await expect(home.getByRole('search')).toHaveCount(0);
    await expect(home.getByRole('searchbox')).toHaveCount(0);
    await expect(home.getByLabel('Search knowledge')).toHaveCount(0);
    await expect(home.getByRole('navigation', { name: 'Shortcuts' })).toHaveCount(0);

    const keyTopics = home.getByRole('complementary', { name: 'Key topics' });
    await expect(keyTopics.getByRole('link', { name: /^All topics/ })).toHaveAttribute('href', '/topics');
  });

  test('pinned topics render with and without an image and a colour, and their covers load anonymously', async ({ signedInPage, browser, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const before = await getPins(apiAsAdmin);

    await makeTopic(apiAsAdmin, `pin-ai-${suffix}`, { description: 'Everything about AI.' });
    await makeTopic(apiAsAdmin, `pin-widget-${suffix}`, { description: 'The product.' });
    await makeTopic(apiAsAdmin, `pin-plain-${suffix}`);
    await makeTopic(apiAsAdmin, `pin-secret-${suffix}`, { visibility: 'private' });

    // This test's own asset, never the seed's cover bytes (R2.5).
    const cover = await uploadCover(apiAsAdmin);

    await putPins(apiAsAdmin, [
      { topic: `pin-ai-${suffix}`, color: 'teal', cover },
      { topic: `pin-widget-${suffix}`, color: 'ochre', icon: 'wrench' },
      { topic: `pin-plain-${suffix}` },
      // An administrator pinning a private topic must not publish it.
      { topic: `pin-secret-${suffix}`, color: 'plum' },
      // And a typo must cost the tenant the pin, never the front page.
      { topic: `pin-ghost-${suffix}` },
    ]);

    try {
      const ctx = await anonymous(browser, new URL(signedInPage.url()).origin);
      try {
        const anon = await ctx.newPage();
        await anon.goto('/');
        const pins = anon.locator('main.Home').getByTestId('home-pin');

        // Three cards, in the curator's order — position is stable, so "the
        // second card" is a thing a person can say in a ticket. The private
        // topic and the typo are both gone, server-side.
        await expect(pins).toHaveCount(3);
        await expect(pins.locator('h3')).toHaveText([
          `pin-ai-${suffix}`,
          `pin-widget-${suffix}`,
          `pin-plain-${suffix}`,
        ]);
        await expect(anon.getByText(`pin-secret-${suffix}`)).toHaveCount(0);

        // Image + colour, icon + colour, and neither — all three are complete
        // cards of ONE shape: the same thumbnail slot holds the cover, else the
        // topic's icon, else a neutral default glyph (R2.5), so no card reads
        // as an image that failed to load. The NAME is always text, so the colour is never the only thing
        // distinguishing two of them.
        await expect(pins.locator('.kp-pin__thumb')).toHaveCount(3);
        await expect(pins.nth(0)).toHaveAttribute('data-pin-color', 'teal');
        await expect(pins.nth(0).locator('.kp-pin__thumb')).toHaveAttribute('data-thumb', 'cover');
        await expect(pins.nth(1)).toHaveAttribute('data-pin-color', 'ochre');
        await expect(pins.nth(1).locator('.kp-pin__thumb')).toHaveAttribute('data-thumb', 'icon');
        await expect(pins.nth(1).locator('.kp-pin__thumb img')).toHaveCount(0);
        await expect(pins.nth(2)).not.toHaveAttribute('data-pin-color', /./);
        await expect(pins.nth(2).locator('.kp-pin__thumb')).toHaveAttribute('data-thumb', 'default');
        await expect(pins.nth(2).locator('.kp-pin__thumb img')).toHaveCount(0);
        await expect(pins.nth(0)).toContainText('Everything about AI.');

        // The cover BYTES, not just the <img> tag: a chrome image is embedded
        // in no published page, so without the branding-asset grant this is a
        // 404 for exactly the visitor the front page is mostly for — and an
        // `<img>` assertion would pass anyway.
        const src = await pins.nth(0).locator('.kp-cover-light').getAttribute('src');
        expect(src).toBe(cover);
        const bytes = await ctx.request.get(src!);
        expect(bytes.status()).toBe(200);
        expect(bytes.headers()['content-type']).toContain('image/png');
        // …and the browser decoded them, in the theme this visitor is in.
        await expectImageLoaded(pins.nth(0).locator('.kp-cover-light'));

        // And the card is a navigation.
        await pins.nth(0).getByRole('link', { name: `pin-ai-${suffix}` }).click();
        await expect(anon).toHaveURL(new RegExp(`/topics/pin-ai-${suffix}$`));
      } finally {
        await ctx.close();
      }
    } finally {
      await putPins(apiAsAdmin, pinDefs(before));
    }
  });

  /**
   * The Hashnode-style feed (R2.11), as the visitor it is mostly for. An image
   * that loads only for the signed-in author is the likeliest regression here —
   * a cover in frontmatter is readable anonymously only because publishing
   * records it as an image link — so every image assertion is made from a
   * browser that has never signed in, against covers this test uploaded.
   */
  test('Updates covers load for an anonymous visitor, and a story without one renders no image', async ({ signedInPage, browser, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const tag = `hncover-${suffix}`;
    const before = await getSections(apiAsAdmin);
    const cover = await uploadCover(apiAsAdmin);

    // Newest first: a covered lead, a covered row, a row with no cover.
    await createPageViaApi(apiAsAdmin, {
      title: `HC Lead ${suffix}`,
      body: 'The lead story.',
      status: 'published',
      tags: [tag],
      frontmatter: { type: 'Blog Post', topic: 'default', authors: ['Ada Lovelace'], description: `Lead brief ${suffix}`, cover, published_at: '2026-03-03T12:00:00.000Z' },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `HC Covered ${suffix}`,
      body: 'A story with a cover.',
      status: 'published',
      tags: [tag],
      frontmatter: { type: 'Blog Post', topic: 'default', description: `Covered brief ${suffix}`, cover, published_at: '2026-03-02T12:00:00.000Z' },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `HC Plain ${suffix}`,
      body: 'A story with no cover.',
      status: 'published',
      tags: [tag],
      frontmatter: { type: 'Blog Post', topic: 'default', description: `Plain brief ${suffix}`, published_at: '2026-03-01T12:00:00.000Z' },
    });
    await putSections(apiAsAdmin, [{ name: `Cover updates ${suffix}`, slug: `hc-${suffix}`, tags: [tag], order: 0, limit: 12 }]);

    try {
      const ctx = await anonymous(browser, new URL(signedInPage.url()).origin);
      try {
        const anon = await ctx.newPage();
        await anon.goto('/');
        const home = anon.locator('main.Home');
        await expect(home.getByRole('heading', { name: `Cover updates ${suffix}` })).toBeVisible();

        // The lead: a wide cover above the title, decorative (the title beside
        // it carries the meaning), then the brief and `Author · date · N min read`.
        const lead = home.getByTestId('home-lead');
        await expect(lead.getByRole('link', { name: `HC Lead ${suffix}` })).toBeVisible();
        const leadCover = lead.locator('img');
        await expect(leadCover).toHaveCount(1);
        await expect(leadCover).toHaveAttribute('src', cover);
        await expect(leadCover).toHaveAttribute('alt', '');
        await expectImageLoaded(leadCover);
        await expect(lead).toContainText(`Lead brief ${suffix}`);
        await expect(lead.locator('.kp-item-meta')).toContainText('Ada Lovelace');
        await expect(lead.locator('.kp-item-meta')).toContainText('min read');
        // `Topic · Author · date · N min read`: the topic first, then the author.
        await expect(lead.locator('.kp-item-meta')).toHaveText(
          new RegExp(`^${escapeRegExp(await topicName(apiAsAdmin, 'default'))}\\s*·\\s*Ada Lovelace\\s*·`),
        );
        await expect(lead.getByTestId('home-topic')).toHaveAttribute('href', '/topics/default');

        // A row with a cover carries it as a trailing thumbnail…
        const rows = home.getByTestId('home-row');
        const covered = rows.filter({ hasText: `HC Covered ${suffix}` });
        await expect(covered.locator('img')).toHaveCount(1);
        await expect(covered.locator('img')).toHaveAttribute('alt', '');
        await expectImageLoaded(covered.locator('img'));
        // …and the thumbnail is not a second link to the story: the row's title
        // is still the only one, so the whole row stays one unambiguous target.
        // (The topic label is a link too, but to the topic, and never wraps the
        // title or the picture.)
        await expect(covered.locator('a[href^="/p/"]')).toHaveCount(1);
        await expect(covered.locator('a img')).toHaveCount(0);
        await expect(covered.locator('a a')).toHaveCount(0);

        // …and a row without one has no image at all — no placeholder, which is
        // exactly what the first design review read as a failed load.
        const plain = rows.filter({ hasText: `HC Plain ${suffix}` });
        await expect(plain).toBeVisible();
        await expect(plain.locator('img')).toHaveCount(0);
        await expect(plain).toContainText(`Plain brief ${suffix}`);

        // The bytes too, from the anonymous context's own cookie jar.
        const bytes = await ctx.request.get(cover);
        expect(bytes.status()).toBe(200);
      } finally {
        await ctx.close();
      }
    } finally {
      await putSections(apiAsAdmin, before);
    }
  });

  test('a lead story without a cover is a text-only card', async ({ signedInPage, browser, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const tag = `hnplain-${suffix}`;
    const before = await getSections(apiAsAdmin);
    await createPageViaApi(apiAsAdmin, {
      title: `HP Lead ${suffix}`,
      body: 'No cover here.',
      status: 'published',
      tags: [tag],
      frontmatter: { type: 'Blog Post', topic: 'default', description: `Text-only lead ${suffix}`, published_at: '2026-03-03T12:00:00.000Z' },
    });
    await putSections(apiAsAdmin, [{ name: `Plain updates ${suffix}`, slug: `hp-${suffix}`, tags: [tag], order: 0, limit: 12 }]);

    try {
      const ctx = await anonymous(browser, new URL(signedInPage.url()).origin);
      try {
        const anon = await ctx.newPage();
        await anon.goto('/');
        const lead = anon.locator('main.Home').getByTestId('home-lead');
        await expect(lead.getByRole('link', { name: `HP Lead ${suffix}` })).toBeVisible();
        await expect(lead).toContainText(`Text-only lead ${suffix}`);
        await expect(lead.locator('img')).toHaveCount(0);
      } finally {
        await ctx.close();
      }
    } finally {
      await putSections(apiAsAdmin, before);
    }
  });

  /**
   * `Start here` came back with revision 2 (R2.2), without the deleted portal
   * branch's hard-coded "New to AI?": it is shown only when the home topic's
   * bundle names a `start_here` item, and it opens that item. With the search
   * field gone it sits with the masthead, above the first screen.
   */
  test('the front page offers Start here near the top only when the home topic names one', async ({ signedInPage, browser, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const list = await apiAsAdmin.get('/api/v1/topics');
    if (!list.ok()) throw new Error(`list topics failed: ${list.status()}`);
    const body = await list.json();
    const topics = (Array.isArray(body) ? body : (body.topics ?? body.items ?? [])) as Record<string, unknown>[];
    // No `site.homeTopic` on the e2e instance, so the home topic is `default`.
    const home = topics.find((t) => t['slug'] === 'default');
    expect(home, 'the e2e instance must have a default topic').toBeTruthy();
    const topicId = home!['id'] as string;
    const landing = await apiAsAdmin.get('/api/v1/topics/default/landing');
    const previous = landing.ok() ? (((await landing.json()).topic?.start_here as string | null | undefined) ?? '') : '';

    const start = await createPageViaApi(apiAsAdmin, {
      title: `Home Start ${suffix}`,
      body: 'Begin with this.',
      status: 'published',
      frontmatter: { type: 'how-to', topic: 'default' },
    });

    try {
      const ctx = await anonymous(browser, new URL(signedInPage.url()).origin);
      try {
        const anon = await ctx.newPage();
        const front = anon.locator('main.Home');

        if (!previous) {
          await anon.goto('/');
          await expect(front.getByTestId('home-lead')).toBeVisible();
          await expect(front.getByRole('link', { name: 'Start here', exact: true })).toHaveCount(0);
        }

        const put = await apiAsAdmin.put(`/api/v1/topics/${topicId}`, { data: { start_here: start.slug } });
        if (!put.ok()) throw new Error(`set start_here failed: ${put.status()} ${await put.text()}`);

        await anon.goto('/');
        const startHere = front.getByRole('link', { name: 'Start here', exact: true });
        await expect(startHere).toBeVisible();
        // Near the top: above the first screen, not somewhere in the feed.
        const feedTop = (await front.locator('.Home__top').boundingBox())!.y;
        expect((await startHere.boundingBox())!.y).toBeLessThan(feedTop);
        await startHere.click();
        await expect(anon).toHaveURL(new RegExp(`/p/${start.slug}$`));
      } finally {
        await ctx.close();
      }
    } finally {
      await apiAsAdmin.put(`/api/v1/topics/${topicId}`, { data: { start_here: previous } });
    }
  });

  test('the pin editor shows the cap of six and blocks a dark cover that has no cover', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const before = await getPins(apiAsAdmin);
    const slugs = Array.from({ length: 6 }, (_, i) => `pincap-${i + 1}-${suffix}`);
    for (const slug of slugs) await makeTopic(apiAsAdmin, slug);
    const cover = await uploadCover(apiAsAdmin);

    try {
      // Six pins, the first with a cover and a dark theme cover of its own.
      await putPins(apiAsAdmin, slugs.map((topic, i) => (i === 0 ? { topic, cover, cover_dark: '/assets/e2e-dark-only.png' } : { topic })));
      await signedInPage.goto('/admin/sections/pinned');
      const main = signedInPage.locator('main.PinnedTopicsAdmin');
      const pin = main.getByRole('button', { name: 'Pin a topic' });
      const count = main.getByTestId('pinned-topics-count');

      // Review §2 #8: the server keeps six and silently drops the rest, so the
      // editor stops at six — and says why in text, not only a tooltip.
      await expect(count).toHaveText('6 of 6');
      await expect(pin).toBeDisabled();
      await expect(main.getByText(/features at most 6 topics\. unpin one to pin another/i)).toBeVisible();

      // A dark cover alone is not a pair the server keeps: clearing the cover
      // flags the dark cover, and the pin cannot be saved until one is back.
      await main.getByRole('button', { name: `Actions for ${slugs[0]}` }).click();
      await signedInPage.getByRole('menuitem', { name: 'Edit' }).click();
      const dialog = signedInPage.getByRole('dialog', { name: 'Edit pin' });
      await dialog.getByRole('group', { name: 'Cover', exact: true }).getByRole('button', { name: 'Clear' }).click();
      await expect(dialog.getByText('Set a cover before a dark theme cover.')).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Save pin' })).toBeDisabled();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await signedInPage.getByRole('dialog', { name: 'Discard changes?' }).getByRole('button', { name: 'Discard' }).click();

      // Nothing was written by any of that.
      const stored = await getPins(apiAsAdmin);
      expect(stored.map((p) => p['topic'])).toEqual(slugs);
      expect(stored[0]!['cover']).toBe(cover);
    } finally {
      await putPins(apiAsAdmin, pinDefs(before));
    }
  });

  test('the section editor labels every field', async ({ signedInPage }) => {
    // The old grid named each input after its row ("Tags for Updates"); the
    // edit page has one section, so every field carries its plain label.
    await signedInPage.goto('/admin/sections/new');
    for (const name of [/^Name/, /^URL/, /^Description/]) {
      await expect(signedInPage.getByRole('textbox', { name })).toBeVisible();
    }
    for (const name of ['Content type', 'Topic', 'Tags']) {
      await expect(signedInPage.getByRole('combobox', { name, exact: true })).toBeVisible();
    }
    // A section with no topic is a front-page section, where Slot applies.
    await expect(signedInPage.getByRole('combobox', { name: 'Slot' })).toBeVisible();
    await expect(signedInPage.getByRole('spinbutton', { name: /^Max items/ })).toHaveValue('10');
    // Leaving without saving writes nothing.
  });

  test('an administrator curates the pin list, and a non-admin cannot', async ({ signedInPage, apiAsAdmin, playwright }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const before = await getPins(apiAsAdmin);
    await makeTopic(apiAsAdmin, `pinadm-${suffix}`);

    try {
      await putPins(apiAsAdmin, []);
      await signedInPage.goto('/admin/sections/pinned');
      await signedInPage.getByRole('button', { name: 'Pin a topic' }).first().click();
      const dialog = signedInPage.getByRole('dialog', { name: 'Pin a topic' });
      await dialog.getByRole('combobox', { name: /^Topic/ }).fill(`pinadm-${suffix}`);
      await dialog.getByRole('option', { name: new RegExp(`pinadm-${suffix}`) }).click();
      await dialog.getByRole('radio', { name: 'Violet' }).check();
      await dialog.getByRole('button', { name: 'Pin topic' }).click();
      await expect(dialog).toHaveCount(0);

      // It survives the round trip and shows on the front page.
      await signedInPage.reload();
      await expect(signedInPage.getByTestId('pinned-topic-card').locator('h3')).toHaveText([`pinadm-${suffix}`]);
      expect((await getPins(apiAsAdmin))[0]).toMatchObject({ topic: `pinadm-${suffix}`, color: 'violet' });
      await signedInPage.goto('/');
      await expect(
        signedInPage.locator('main.Home').getByTestId('home-pin').locator('h3'),
      ).toHaveText([`pinadm-${suffix}`]);

      // The constraint this feature is really about: a signed-in individual
      // cannot change what the company features.
      const alice = await createUserApiContext(playwright, apiAsAdmin, {
        username: `pinuser${testInfo.workerIndex}`,
      });
      try {
        const refused = await alice.put('/api/v1/site/pinned', { data: { pinned: [] } });
        expect(refused.status()).toBe(403);
        // Nothing the refused write asked for happened.
        expect((await getPins(apiAsAdmin)).map((p) => p['topic'])).toEqual([`pinadm-${suffix}`]);
      } finally {
        await alice.dispose();
      }
    } finally {
      await putPins(apiAsAdmin, pinDefs(before));
    }
  });
});
