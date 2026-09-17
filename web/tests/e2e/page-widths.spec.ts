import { test, expect } from './fixtures.js';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * Shared page widths (owner decision, Eric, 2026-09-13): every page is centred,
 * list / landing / utility pages cap their content at `--kp-page-width` (80rem,
 * 1280px) and multi-column pages (Home) at `--kp-page-width-wide` (96rem,
 * 1536px). Both are tokens in packages/ui/src/tokens.css, applied as
 *   padding-inline: max(var(--kp-page-gutter), calc((100% - cap) / 2))
 * on the page's scroll container (Search: on `.Search__inner`, so the size
 * container it queries keeps the page's full width).
 *
 * What this pins: on a 1920px monitor the content box is no wider than its cap
 * and has equal space either side of it inside the scroll container (not the
 * viewport — the app sidebar takes the left of that); on a 390px phone nothing
 * overflows sideways. The content box is read from the rendered geometry and
 * the computed padding, because a page that forgot the pattern (an auto margin
 * on an inner wrapper, a stray max-width) would still look centred in a
 * screenshot but fail the scroll-container and full-bleed rules the pattern
 * exists for.
 */

const SCROLLER = '.kp-main > :not(header):not(.kp-global-header)';
/** Token values in rem; converted with the page's REAL root font size (15px in
 *  this app, not the browser's 16px default — assuming 16 is how the caps were
 *  first misreported as 1280/1536px). */
const PAGE_WIDTH_REM = 85;
const PAGE_WIDTH_WIDE_REM = 96;

interface Route {
  label: string;
  path: string;
  /** The element that carries the centring padding. */
  frame: string;
  capRem: number;
}

async function seedTopic(api: APIRequestContext, suffix: string): Promise<string> {
  const slug = `widths-${suffix}`;
  const res = await api.post('/api/v1/topics', {
    data: { name: `Widths Topic ${suffix}`, slug, description: 'A topic for the page-width check.' },
  });
  if (!res.ok()) throw new Error(`seed topic failed: ${res.status()} ${await res.text()}`);
  return slug;
}

function routes(topicSlug: string): Route[] {
  return [
    { label: 'Home', path: '/', frame: 'main.Home', capRem: PAGE_WIDTH_WIDE_REM },
    { label: 'Latest', path: '/latest', frame: 'main.Feed', capRem: PAGE_WIDTH_REM },
    { label: 'Topics', path: '/topics', frame: 'main.TopicsIndex', capRem: PAGE_WIDTH_REM },
    { label: 'Topic landing', path: `/topics/${topicSlug}`, frame: 'main.TopicLanding', capRem: PAGE_WIDTH_REM },
    { label: 'Search', path: '/search', frame: '.Search__inner', capRem: PAGE_WIDTH_REM },
  ];
}

/** The frame's content box and its side gaps, measured inside the route's scroll container. */
async function measure(page: Page, frame: string) {
  return page.evaluate(
    ({ frame, scrollerSelector }) => {
      const el = document.querySelector<HTMLElement>(frame);
      // The route's scroll container is the frame itself or its nearest scrolling
      // ancestor. Not simply `.kp-main > :not(header)`: above the reading-pane
      // threshold a `display: contents` wrapper sits there, with no box to measure.
      let scroller: HTMLElement | null = el;
      while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      scroller ??= document.querySelector<HTMLElement>(scrollerSelector);
      if (!el || !scroller) return null;
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const contentLeft = box.left + el.clientLeft + parseFloat(style.paddingLeft);
      const contentRight = box.left + el.clientLeft + el.clientWidth - parseFloat(style.paddingRight);
      const frameBox = scroller.getBoundingClientRect();
      const frameLeft = frameBox.left + scroller.clientLeft;
      const frameRight = frameLeft + scroller.clientWidth;
      return {
        width: contentRight - contentLeft,
        leftGap: contentLeft - frameLeft,
        rightGap: frameRight - contentRight,
        scrollerWidth: scroller.clientWidth,
      };
    },
    { frame, scrollerSelector: SCROLLER },
  );
}

async function horizontalOverflow(page: Page) {
  return page.evaluate((scrollerSelector) => {
    const doc = document.documentElement;
    const scroller = document.querySelector<HTMLElement>(scrollerSelector);
    return {
      document: doc.scrollWidth - window.innerWidth,
      scroller: scroller ? scroller.scrollWidth - scroller.clientWidth : 0,
    };
  }, SCROLLER);
}

test.describe('shared page widths', () => {
  test('on a 1920px monitor each page is centred and held to its cap', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const slug = await seedTopic(apiAsAdmin, `${testInfo.workerIndex}-${Date.now()}`);
    await signedInPage.setViewportSize({ width: 1920, height: 1080 });

    for (const route of routes(slug)) {
      await signedInPage.goto(route.path);
      await expect(signedInPage.locator(route.frame).first(), `${route.label} renders`).toBeVisible({ timeout: 15_000 });
      const m = await measure(signedInPage, route.frame);
      const remPx = await signedInPage.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
      const cap = route.capRem * remPx;
      expect(m, `${route.label}: frame and scroll container found`).not.toBeNull();
      // Meaningful only if the screen is wider than the cap plus two gutters.
      expect(m!.scrollerWidth, `${route.label}: the scroll container is wider than the cap`).toBeGreaterThan(cap + 80);
      expect(m!.width, `${route.label}: content no wider than ${cap}px`).toBeLessThanOrEqual(cap + 2);
      // At this width the cap, not the gutter, sets the padding, so the content
      // fills the cap exactly.
      expect(m!.width, `${route.label}: content fills its cap`).toBeGreaterThanOrEqual(cap - 2);
      expect(Math.abs(m!.leftGap - m!.rightGap), `${route.label}: equal side gaps (${m!.leftGap} vs ${m!.rightGap})`).toBeLessThanOrEqual(2);
    }
  });

  test('on a 390px phone no page overflows sideways', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const slug = await seedTopic(apiAsAdmin, `${testInfo.workerIndex}-${Date.now()}`);
    await signedInPage.setViewportSize({ width: 390, height: 844 });

    for (const route of routes(slug)) {
      await signedInPage.goto(route.path);
      await expect(signedInPage.locator(route.frame).first(), `${route.label} renders`).toBeVisible({ timeout: 15_000 });
      const overflow = await horizontalOverflow(signedInPage);
      expect(overflow.document, `${route.label}: document overflow at 390px`).toBeLessThanOrEqual(0);
      expect(overflow.scroller, `${route.label}: clipped content at 390px`).toBeLessThanOrEqual(1);
    }
  });
});
