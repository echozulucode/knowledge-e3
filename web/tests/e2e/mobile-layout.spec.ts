import { test, expect, ADMIN } from './fixtures.js';
import type { Browser, BrowserContext, Page } from '@playwright/test';

/**
 * Phone widths (the home prototype plan, R3.1: "No horizontal page scroll at
 * 360px").
 *
 * What this pins, all found by a 360/390px sweep on 2026-09-12:
 *
 * - **The header.** Hamburger, topic switcher, search, theme and Sign In did
 *   not fit a phone, and nothing in the row was allowed to give: "Sign In"
 *   wrapped onto two lines, the switcher's chevron slid under the search
 *   button, and the theme icon was squeezed to 26px. Now the switcher is the
 *   one flexible item (its label ellipsizes), the theme toggle moves into the
 *   navigation drawer, and every control keeps a 40px target.
 * - **Clipped overflow.** The app shell's scroll container hides horizontal
 *   overflow, so an over-wide page does not scroll sideways — it silently cuts
 *   content off (a topic landing's update rows ran ~730px wide, the Sections
 *   admin table lost its right-hand columns). `scrollWidth` on the document
 *   alone would never see that, so the check is made on the scroll container.
 *
 * One browser context per width and sign-in state, reusing its page across
 * routes, keeps this to four tests. The contexts are made with
 * `browser.newContext()` so the signed-out pass is genuinely anonymous (see
 * home.spec.ts on issue 112).
 */

const WIDTHS = [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
] as const;

/** Readable signed out (`readAccess.default` is public). */
const READER_ROUTES = ['/', '/topics', '/topics/product-workspace', '/latest', '/search?q=topic', '/series/getting-started', '/browse?view=grouped&topic=product-workspace'];
/** Signed in only. */
const ADMIN_ROUTES = ['/new', '/admin', '/admin/sections', '/admin/sections/new', '/admin/sections/pinned', '/admin/health', '/admin/health/system', '/admin/users', '/admin/auth', '/admin/auth/tokens', '/admin/topics', '/admin/topics/default', '/admin/tags-groups', '/admin/tags-groups?view=groups', '/admin/primary-categories', '/admin/primary-categories?view=archived', '/admin/images', '/admin/images?view=list', '/admin/data', '/admin/data?tab=audit'];
/** Admin pages render inside AdminLayout, whose nav is a section switcher on a phone. */
const isAdmin = (route: string) => route.startsWith('/admin');

async function openContext(browser: Browser, baseURL: string, viewport: { width: number; height: number }, signedIn: boolean): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL, viewport });
  const page = await ctx.newPage();
  if (signedIn) {
    await page.goto('/login');
    await page.getByLabel('Username').fill(ADMIN.username);
    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 10_000 });
  }
  return { ctx, page };
}

async function settle(page: Page) {
  await expect(page.locator('.kp-header')).toBeVisible();
  // Late images and queries can still widen a row; wait for the network to go
  // quiet, but do not fail a layout check on a long-poll that never does.
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
}

/** Every visible header control: inside the viewport, on one line, not overlapping, >= 40px tall. */
async function expectHeaderFits(page: Page, label: string) {
  const report = await page.evaluate(() => {
    const vw = window.innerWidth;
    const problems: string[] = [];
    const controls = Array.from(document.querySelectorAll<HTMLElement>('.kp-header-content button'))
      .filter((el) => el.getBoundingClientRect().width > 0 && !el.closest('.kp-switcher-popover, .kp-user-dropdown'));
    const name = (el: HTMLElement) => el.getAttribute('aria-label') ?? (el.textContent ?? '').trim();
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      if (r.left < -1 || r.right > vw + 1) problems.push(`"${name(el)}" is outside the viewport (${Math.round(r.left)}..${Math.round(r.right)})`);
      if (r.height < 40) problems.push(`"${name(el)}" is ${Math.round(r.height)}px tall`);
      // One line: every text box in the control shares a line top. A wrapped
      // label has a second line a full line-height below the first.
      const range = document.createRange();
      range.selectNodeContents(el);
      const tops = Array.from(range.getClientRects()).filter((b) => b.width > 0).map((b) => b.top);
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
      if (tops.length > 1 && Math.max(...tops) - Math.min(...tops) > lineHeight * 0.8) problems.push(`"${name(el)}" wraps`);
    }
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i]!.getBoundingClientRect();
        const b = controls[j]!.getBoundingClientRect();
        if (a.left < b.right - 1 && b.left < a.right - 1) problems.push(`"${name(controls[i]!)}" overlaps "${name(controls[j]!)}"`);
      }
    }
    return problems;
  });
  expect(report, `header at ${label}`).toEqual([]);
}

/** Neither the document nor the shell's (overflow-x: hidden) scroll container is wider than the viewport. */
async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const scroller = document.querySelector<HTMLElement>('.kp-main > :not(header)');
    return {
      document: doc.scrollWidth - window.innerWidth,
      scroller: scroller ? scroller.scrollWidth - scroller.clientWidth : 0,
    };
  });
  expect(overflow.document, `document overflow at ${label}`).toBeLessThanOrEqual(0);
  expect(overflow.scroller, `content overflow (clipped) at ${label}`).toBeLessThanOrEqual(1);
}

/**
 * On a phone the admin nav is ONE row: "Admin › <page>" as a disclosure. The
 * desktop column and the tablet rows are not rendered as well (the review's
 * old tab bar wrapped to four rows, ~200px, above every admin page).
 */
async function expectAdminSwitcher(page: Page, label: string) {
  const nav = page.getByRole('navigation', { name: 'Admin' });
  const switcher = nav.getByRole('button', { name: /^Admin/ });
  await expect(switcher, `admin switcher at ${label}`).toBeVisible();
  await expect(switcher).toHaveAttribute('aria-expanded', 'false');
  const box = await switcher.boundingBox();
  expect(box?.height ?? 0, `admin switcher height at ${label}`).toBeLessThan(64);
  // Closed, the only link-shaped thing the nav shows is the switcher itself.
  await expect(nav.getByRole('link')).toHaveCount(0);
}

for (const viewport of WIDTHS) {
  test.describe(`at ${viewport.width}px`, () => {
    test('signed out: the header fits on one line and reader routes do not overflow', async ({ browser, baseURL }) => {
      test.setTimeout(120_000);
      const { ctx, page } = await openContext(browser, baseURL!, viewport, false);
      try {
        for (const route of READER_ROUTES) {
          await page.goto(route);
          await settle(page);
          const label = `${viewport.width}px ${route} (signed out)`;
          await expectHeaderFits(page, label);
          await expectNoHorizontalOverflow(page, label);
        }
        await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();

        // An article, reached the way a reader reaches one.
        await page.goto('/series/getting-started');
        await page.getByTestId('series-part').nth(1).getByRole('link').first().click();
        await page.waitForURL((u) => !u.pathname.startsWith('/series'));
        await settle(page);
        await expectHeaderFits(page, `${viewport.width}px article (signed out)`);
        await expectNoHorizontalOverflow(page, `${viewport.width}px article (signed out)`);
        // The article column is centred at every width, but on a phone the
        // body is far narrower than the 128ch measure, so it fills the body
        // edge to edge — centring must not open a gutter here.
        const column = await page.evaluate(() => {
          const body = document.querySelector<HTMLElement>('.kp-pageview-body')!;
          const reader = document.querySelector<HTMLElement>('.kp-article-reader')!.getBoundingClientRect();
          const left = body.getBoundingClientRect().left + body.clientLeft;
          return { leftGap: reader.left - left, rightGap: left + body.clientWidth - reader.right };
        });
        expect(Math.abs(column.leftGap), `${viewport.width}px article column left edge`).toBeLessThanOrEqual(1);
        expect(Math.abs(column.rightGap), `${viewport.width}px article column right edge`).toBeLessThanOrEqual(1);

        // A long topic name truncates in place and keeps its accessible name.
        await page.goto('/browse?view=grouped&topic=product-workspace');
        await settle(page);
        const crumb = page.getByRole('button', { name: /product workspace/i }).and(page.locator('.kp-switcher-crumb'));
        await expect(crumb).toBeVisible();
        await expectHeaderFits(page, `${viewport.width}px /browse?topic=product-workspace (signed out)`);
        const label = page.locator('.kp-switcher-label');
        await expect(label).toHaveCSS('text-overflow', 'ellipsis');
        await expect(label).toHaveCSS('white-space', 'nowrap');

        // Browse's stacked controls: the search field's row-direction flex basis
        // once became a 320px-tall blank band under its input in the column.
        const searchField = await page.locator('.PageList__MainSearch').boundingBox();
        expect(searchField?.height ?? 0, 'browse search field height').toBeLessThan(120);

        // The theme toggle left the header for the drawer rather than shrinking.
        await expect(page.locator('.kp-header').getByRole('button', { name: /current theme/i })).toBeHidden();
        await page.getByRole('button', { name: 'Open navigation' }).click();
        const drawer = page.locator('.kp-sidebar');
        const drawerTheme = drawer.getByRole('button', { name: /current theme/i });
        await expect(drawerTheme).toBeVisible();
        // One quick search, and it is the header's: the drawer offers the
        // Search destination (the /search page) but no search box of its own.
        await expect(drawer.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
        await expect(drawer.getByRole('textbox')).toHaveCount(0);
        await expect(drawer.getByRole('searchbox')).toHaveCount(0);
        const before = await page.locator('html').getAttribute('data-theme');
        await drawerTheme.click();
        await expect(page.locator('html')).not.toHaveAttribute('data-theme', before ?? '');
      } finally {
        await ctx.close();
      }
    });

    test('signed in: the header fits on one line and reader and admin routes do not overflow', async ({ browser, baseURL }) => {
      test.setTimeout(150_000);
      const { ctx, page } = await openContext(browser, baseURL!, viewport, true);
      try {
        for (const route of [...READER_ROUTES, ...ADMIN_ROUTES]) {
          await page.goto(route);
          await settle(page);
          const label = `${viewport.width}px ${route} (signed in)`;
          await expectHeaderFits(page, label);
          await expectNoHorizontalOverflow(page, label);
          if (isAdmin(route)) await expectAdminSwitcher(page, label);
        }

        // The switcher opens over the whole list, and a link in it navigates and closes it.
        await page.goto('/admin');
        await settle(page);
        const nav = page.getByRole('navigation', { name: 'Admin' });
        const switcher = nav.getByRole('button', { name: /^Admin/ });
        await switcher.click();
        await expect(switcher).toHaveAttribute('aria-expanded', 'true');
        await expectNoHorizontalOverflow(page, `${viewport.width}px /admin (switcher open)`);
        await nav.getByRole('link', { name: 'Users', exact: true }).click();
        await expect(page).toHaveURL(/\/admin\/users$/);
        await expect(switcher).toHaveAttribute('aria-expanded', 'false');
        await expect(switcher).toContainText('Users');

        // The username is hidden to make room, not the menu: its name still says whose it is.
        await expect(page.getByRole('button', { name: /user menu for admin/i })).toBeVisible();
      } finally {
        await ctx.close();
      }
    });
  });
}

/**
 * Tablet (the admin AREA between 40rem and 64rem — at an 800px viewport the app
 * rail is a drawer, so the area is the viewport less its gutter). The top-level
 * items are one row that scrolls sideways rather than wrapping, and the active
 * item's children are a second row.
 */
test.describe('admin nav at tablet width', () => {
  test('one non-wrapping row of items, plus the active children, and no page overflow', async ({ browser, baseURL }) => {
    const { ctx, page } = await openContext(browser, baseURL!, { width: 800, height: 1000 }, true);
    try {
      await page.goto('/admin/health/system');
      await settle(page);
      const nav = page.getByRole('navigation', { name: 'Admin' });
      await expect(nav.getByRole('button', { name: /^Admin/ })).toBeHidden();

      const rows = await page.evaluate(() => {
        const tops = (selector: string) =>
          Array.from(document.querySelectorAll<HTMLElement>(selector))
            .filter((el) => el.getBoundingClientRect().width > 0)
            .map((el) => Math.round(el.getBoundingClientRect().top));
        return {
          items: tops('.kp-admin-nav__groups > li > ul > li > .kp-admin-nav__item'),
          children: tops('.kp-admin-nav__subrow .kp-admin-nav__child'),
        };
      });
      expect(rows.items.length, 'top-level items rendered').toBeGreaterThan(5);
      expect(new Set(rows.items).size, 'top-level items share one row').toBe(1);
      expect(rows.children.length, 'Health children rendered').toBe(2);
      expect(new Set(rows.children).size, 'children share one row').toBe(1);
      expect(rows.children[0]!, 'children sit below the items').toBeGreaterThan(rows.items[0]!);

      await expect(nav.getByRole('list', { name: 'Health' }).getByRole('link', { name: 'System' })).toHaveAttribute('aria-current', 'page');
      await expectNoHorizontalOverflow(page, '800px /admin/health/system');
    } finally {
      await ctx.close();
    }
  });
});

/**
 * Tags & groups and Primary categories on a phone (review §3.3: tables become
 * cards, actions stay reachable in `⋯`). The routes are in ADMIN_ROUTES for the
 * overflow check; this pins that the controls a phone admin needs are there.
 */
test.describe('taxonomy admin on a phone', () => {
  test('the view switch, tag toolbar and row menus fit and work at 360px', async ({ browser, baseURL }) => {
    const { ctx, page } = await openContext(browser, baseURL!, WIDTHS[0], true);
    try {
      await page.goto('/admin/tags-groups');
      await settle(page);
      const tabs = page.getByRole('tablist', { name: 'Tags and groups views' });
      await expect(tabs.getByRole('tab', { name: /^Tags/ })).toBeVisible();
      await expect(tabs.getByRole('tab', { name: /^Groups/ })).toBeVisible();
      for (const control of [page.getByRole('searchbox', { name: 'Search tags' }), page.getByLabel('Sort'), page.getByRole('button', { name: 'Used by only 1 item' })]) {
        const box = await control.boundingBox();
        expect(box, 'tag toolbar control rendered').not.toBeNull();
        expect(box!.x + box!.width, 'tag toolbar control inside the viewport').toBeLessThanOrEqual(WIDTHS[0].width);
      }
      // Cards, not a table squeezed to 360px: the header row is not shown.
      await expect(page.locator('.kp-dt__table thead')).toBeHidden();
      await expectNoHorizontalOverflow(page, '360px /admin/tags-groups');

      await tabs.getByRole('tab', { name: /^Groups/ }).click();
      await expect(page).toHaveURL(/[?&]view=groups/);
      await expect(page.getByRole('button', { name: 'New group' }).first()).toBeVisible();
      await expectNoHorizontalOverflow(page, '360px /admin/tags-groups?view=groups');

      await page.goto('/admin/primary-categories');
      await settle(page);
      await expect(page.getByRole('button', { name: 'New primary category' }).first()).toBeVisible();
      const menu = page.getByRole('button', { name: /^Actions for / }).first();
      if (await menu.count()) {
        await menu.click();
        await expect(page.getByRole('menuitem', { name: 'View items' })).toBeVisible();
        await page.keyboard.press('Escape');
      }
      await expectNoHorizontalOverflow(page, '360px /admin/primary-categories');
    } finally {
      await ctx.close();
    }
  });
});
