import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';

/**
 * Maps to features/20-admin-console.feature — the admin layout and its grouped
 * navigation (the admin UX review §3.1, §4.9).
 *
 * The nav switches presentation on the width of the admin AREA; these tests fix
 * the viewport so the presentation is known: 1440px (the app rail starts
 * collapsed, so the area is well past 64rem) for the left column, 390px for the
 * phone switcher. The tablet row is pinned in mobile-layout.spec.ts.
 *
 * Badges and "Needs attention" depend on states the seeded instance does not
 * have (a source mid-conflict, a Degraded verdict), so those reports are staged
 * at the boundary the UI reads, as system-health.spec.ts does.
 */

const DESKTOP = { width: 1440, height: 900 };

/**
 * A name matcher for the group headings. They are styled uppercase; matching
 * whole-and-case-insensitive keeps the test about the words, not the CSS.
 */
const named = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
const PHONE = { width: 390, height: 844 };

/** A source registry with one source stuck on two conflicted paths. */
async function stageConflictedSource(page: Page): Promise<void> {
  await page.route('**/api/v1/admin/sources', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sources: [
          {
            id: 'main',
            space_id: null,
            local_dir: 'data/repos/main',
            remote_url: null,
            branch: 'main',
            role: 'authoritative',
            mode: 'direct',
            branch_prefix: null,
            host_kind: null,
            host_base_url: null,
            host_token_env: null,
            sync_every_seconds: null,
            webhook_secret_env: null,
            default_status: null,
            enabled: 1,
            last_synced_at: null,
            last_error: null,
            status: {
              source: 'main',
              state: 'conflict',
              ahead: 0,
              behind: 0,
              dirty_paths: [],
              conflicted_paths: ['concepts/a.md', 'concepts/b.md'],
              last_synced_at: null,
              last_error: null,
            },
          },
        ],
      }),
    });
  });
}

/** The real system report, with its verdict overridden. */
async function stageVerdict(page: Page, verdict: 'healthy' | 'degraded' | 'at_risk'): Promise<void> {
  await page.route('**/api/v1/admin/health/system*', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { verdict: string; checks: { state: string }[] };
    body.verdict = verdict;
    if (verdict === 'healthy') for (const check of body.checks) check.state = 'ok';
    await route.fulfill({ status: response.status(), contentType: 'application/json', body: JSON.stringify(body) });
  });
}

/** An empty registry: nothing in conflict, no secrets to miss. */
async function stageNoSources(page: Page): Promise<void> {
  await page.route('**/api/v1/admin/sources', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sources: [] }) });
  });
}

test.describe('Admin navigation on a wide screen', () => {
  test.use({ viewport: DESKTOP });

  test('groups the destinations under headings and marks the page with aria-current', async ({ signedInPage: page }) => {
    await page.goto('/admin/users');
    const nav = page.getByRole('navigation', { name: 'Admin' });
    await expect(nav).toBeVisible({ timeout: 15_000 });

    // Links in lists, not tabs.
    await expect(nav.getByRole('tablist')).toHaveCount(0);
    await expect(nav.getByRole('tab')).toHaveCount(0);

    for (const [group, items] of [
      ['People & access', ['Users', 'Authentication', 'Audit']],
      ['Content', ['Taxonomy', 'Sections', 'Files']],
      ['Operations', ['Data', 'Sources', 'Health']],
    ] as const) {
      const list = nav.getByRole('list', { name: named(group) });
      await expect(list).toBeVisible();
      for (const label of items) await expect(list.getByRole('link', { name: new RegExp(`^${label}`) })).toBeVisible();
    }
    await expect(nav.getByRole('link', { name: 'Overview', exact: true })).toHaveAttribute('href', '/admin');

    await expect(nav.getByRole('link', { name: 'Users', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(nav.locator('[aria-current="page"]:visible')).toHaveCount(1);
    // Children show under the active branch only.
    await expect(nav.getByRole('list', { name: 'Taxonomy' })).toHaveCount(0);

    // The nav stays put in the layout: the page scrolls, the column does not.
    const before = await nav.boundingBox();
    await page.locator('.kp-admin-layout').evaluate((el) => el.scrollTo({ top: 400 }));
    const after = await nav.boundingBox();
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0)), 'sticky nav').toBeLessThan(40);
  });

  test('a parent opens on its first child and lights the right one on nested paths', async ({ signedInPage: page }) => {
    await page.goto('/admin');
    const nav = page.getByRole('navigation', { name: 'Admin' });
    await expect(nav.getByRole('link', { name: 'Overview', exact: true })).toHaveAttribute('aria-current', 'page');

    await nav.getByRole('link', { name: 'Taxonomy', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/topics$/);
    const taxonomy = nav.getByRole('list', { name: 'Taxonomy' });
    await expect(taxonomy.getByRole('link', { name: 'Topics' })).toHaveAttribute('aria-current', 'page');
    await taxonomy.getByRole('link', { name: 'Categories' }).click();
    await expect(page).toHaveURL(/\/admin\/primary-categories$/);
    await expect(taxonomy.getByRole('link', { name: 'Categories' })).toHaveAttribute('aria-current', 'page');
    await expect(taxonomy.getByRole('link', { name: 'Topics' })).not.toHaveAttribute('aria-current', 'page');

    // /admin/sections is a prefix of /admin/sections/pinned: only one is the page.
    await page.goto('/admin/sections/pinned');
    const sections = nav.getByRole('list', { name: 'Sections' });
    await expect(sections.getByRole('link', { name: 'Pinned topics' })).toHaveAttribute('aria-current', 'page');
    await expect(sections.getByRole('link', { name: 'Sections', exact: true })).not.toHaveAttribute('aria-current', 'page');
    await page.goto('/admin/sections/new');
    await expect(sections.getByRole('link', { name: 'Sections', exact: true })).toHaveAttribute('aria-current', 'page');

    // Same for /admin/health and /admin/health/system.
    await page.goto('/admin/health');
    const health = nav.getByRole('list', { name: 'Health' });
    await expect(health.getByRole('link', { name: 'Content' })).toHaveAttribute('aria-current', 'page');
    await expect(health.getByRole('link', { name: 'System' })).not.toHaveAttribute('aria-current', 'page');
  });

  test('every existing admin URL still opens its page inside the layout', async ({ signedInPage: page }) => {
    const pages: [string, RegExp][] = [
      ['/admin', /^Admin console$/],
      ['/admin/users', /^Users$/],
      ['/admin/auth', /^Authentication$/],
      ['/admin/auth/tokens', /^API tokens$/],
      ['/admin/audit', /^Audit$/],
      ['/admin/topics', /^Topics$/],
      ['/admin/primary-categories', /^Primary categories$/],
      ['/admin/tags-groups', /^Tags & groups$/],
      ['/admin/data', /^Data$/],
      ['/admin/repos', /^Sources$/],
      ['/admin/images', /^Files$/],
      ['/admin/health', /^Content health$/],
      ['/admin/health/system', /^System health$/],
    ];
    for (const [url, title] of pages) {
      await page.goto(url);
      await expect(page.getByRole('navigation', { name: 'Admin' }), url).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('heading', { level: 1, name: title }), url).toBeVisible();
      // One admin nav, not the layout's plus a page's own.
      await expect(page.getByRole('navigation', { name: /^Admin/ }), url).toHaveCount(1);
    }
  });

  test('badges: open conflicts on Sources, "!" on Health while the verdict is not healthy', async ({ signedInPage: page }) => {
    await stageConflictedSource(page);
    await stageVerdict(page, 'degraded');
    await page.goto('/admin/audit');
    const nav = page.getByRole('navigation', { name: 'Admin' });

    const sources = nav.getByRole('link', { name: /^Sources/ });
    await expect(sources).toHaveAccessibleName('Sources, 2 open conflicts', { timeout: 15_000 });
    await expect(sources.getByTestId('admin-nav-badge')).toHaveText('2');

    const health = nav.getByRole('link', { name: /^Health/ });
    await expect(health).toHaveAccessibleName('Health, system degraded');
    await expect(health.getByTestId('admin-nav-badge')).toHaveText('!');
  });

  test('no badges when nothing is wrong', async ({ signedInPage: page }) => {
    await stageNoSources(page);
    await stageVerdict(page, 'healthy');
    await page.goto('/admin/audit');
    const nav = page.getByRole('navigation', { name: 'Admin' });
    await expect(nav.getByRole('link', { name: 'Sources', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(nav.getByRole('link', { name: 'Health', exact: true })).toBeVisible();
    await expect(nav.getByTestId('admin-nav-badge')).toHaveCount(0);
  });
});

test.describe('Admin Overview', () => {
  test.use({ viewport: DESKTOP });

  test('lists what needs attention, worst first, each linked to where it is fixed', async ({ signedInPage: page }) => {
    await stageConflictedSource(page);
    await stageVerdict(page, 'degraded');
    await page.goto('/admin');
    const attention = page.getByRole('region', { name: 'Needs attention' });
    const items = attention.getByRole('listitem');
    await expect(items.first()).toContainText('2 open sync conflicts', { timeout: 15_000 });
    // A deep link into Sources: one blocked source opens its Conflicts tab, several open the filtered list.
    await expect(attention.getByRole('link', { name: '2 open sync conflicts' })).toHaveAttribute('href', /^\/admin\/repos\?(source=[^&]+&tab=conflicts|state=attention)$/);
    await expect(attention.getByRole('link', { name: 'System health: Degraded' })).toHaveAttribute('href', '/admin/health/system');
    // Content health is never fetched from here; the page says it was not consulted.
    await expect(attention).toContainText(/content health is not included/i);
  });

  test('says "Everything looks healthy" when every live check is clear', async ({ signedInPage: page }) => {
    await stageNoSources(page);
    await stageVerdict(page, 'healthy');
    let contentHealthRequested = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/v1/admin/health/content')) contentHealthRequested = true;
    });
    await page.goto('/admin');
    const attention = page.getByRole('region', { name: 'Needs attention' });
    await expect(attention).toContainText('Everything looks healthy', { timeout: 15_000 });
    await expect(attention.getByRole('listitem')).toHaveCount(0);
    expect(contentHealthRequested, 'the Overview must not start the content-health scan').toBe(false);
  });

  test('Needs attention comes before the shortcuts', async ({ signedInPage: page }) => {
    await page.goto('/admin');
    const attention = page.getByRole('region', { name: 'Needs attention' });
    const people = page.getByRole('region', { name: named('People & access') });
    await expect(people).toBeVisible({ timeout: 15_000 });
    const [a, p] = await Promise.all([attention.boundingBox(), people.boundingBox()]);
    expect(a!.y).toBeLessThan(p!.y);
  });

  test('offers the nav’s three groups as shortcut columns, with nav labels, links and counts', async ({ signedInPage: page }) => {
    await page.goto('/admin');
    const groups: [string, [string, string][]][] = [
      ['People & access', [['Users', '/admin/users'], ['Authentication', '/admin/auth'], ['API tokens', '/admin/auth/tokens'], ['Audit', '/admin/audit']]],
      ['Content', [['Topics', '/admin/topics'], ['Categories', '/admin/primary-categories'], ['Tags & groups', '/admin/tags-groups'], ['Sections', '/admin/sections'], ['Files', '/admin/images']]],
      ['Operations', [['Data', '/admin/data'], ['Sources', '/admin/repos'], ['Health', '/admin/health/system']]],
    ];
    for (const [heading, shortcuts] of groups) {
      const region = page.getByRole('region', { name: named(heading) });
      await expect(region).toBeVisible({ timeout: 15_000 });
      await expect(region.getByRole('link')).toHaveText(shortcuts.map(([label]) => label));
      for (const [label, href] of shortcuts) {
        await expect(region.getByRole('link', { name: label, exact: true }), label).toHaveAttribute('href', href);
      }
    }
    // Side by side on a wide screen: one column per group.
    const tops = await Promise.all(groups.map(([heading]) => page.getByRole('region', { name: named(heading) }).boundingBox()));
    expect(new Set(tops.map((box) => Math.round(box!.y))).size).toBe(1);

    const content = page.getByRole('region', { name: named('Content') });
    const topics = content.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Topics', exact: true }) });
    await expect(topics).toContainText(/\d+ topics?/);
    const people = page.getByRole('region', { name: named('People & access') });
    const tokens = people.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'API tokens', exact: true }) });
    await expect(tokens).toContainText(/\d+ active tokens?/);
  });

  test('a shortcut opens its page', async ({ signedInPage: page }) => {
    await page.goto('/admin');
    await page.getByRole('region', { name: named('People & access') }).getByRole('link', { name: 'Audit', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/audit$/);
    await expect(page.getByRole('heading', { level: 1, name: /^Audit$/ })).toBeVisible();
  });
});

test.describe('Admin Overview on a phone', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('the shortcut columns stack, and nothing overflows', async ({ signedInPage: page }) => {
    await page.goto('/admin');
    const boxes = await Promise.all(
      ['People & access', 'Content', 'Operations'].map(async (heading) => {
        const region = page.getByRole('region', { name: named(heading) });
        await expect(region).toBeVisible({ timeout: 15_000 });
        return region.boundingBox();
      }),
    );
    expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);
    expect(boxes[1]!.y).toBeLessThan(boxes[2]!.y);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('Admin navigation on a phone', () => {
  test.use({ viewport: PHONE });

  test('a section switcher opens the grouped list, closes on Escape, and navigates', async ({ signedInPage: page }) => {
    await page.goto('/admin/topics');
    const nav = page.getByRole('navigation', { name: 'Admin' });
    const switcher = nav.getByRole('button', { name: /^Admin/ });
    await expect(switcher).toBeVisible({ timeout: 15_000 });
    await expect(switcher).toContainText('Topics');
    await expect(switcher).toHaveAttribute('aria-expanded', 'false');
    await expect(nav.getByRole('link')).toHaveCount(0);

    await switcher.click();
    await expect(switcher).toHaveAttribute('aria-expanded', 'true');
    for (const heading of ['People & access', 'Content', 'Operations']) {
      await expect(nav.getByRole('list', { name: named(heading) })).toBeVisible();
    }
    await expect(nav.getByRole('link', { name: 'Topics', exact: true })).toHaveAttribute('aria-current', 'page');

    await page.keyboard.press('Escape');
    await expect(switcher).toHaveAttribute('aria-expanded', 'false');
    await expect(switcher).toBeFocused();
    await expect(nav.getByRole('link')).toHaveCount(0);

    await switcher.click();
    await nav.getByRole('link', { name: 'System' }).click();
    await expect(page).toHaveURL(/\/admin\/health\/system$/);
    await expect(switcher).toHaveAttribute('aria-expanded', 'false');
    await expect(switcher).toContainText('System health');
  });

  test('the closed switcher says when something needs attention', async ({ signedInPage: page }) => {
    await stageConflictedSource(page);
    await page.goto('/admin/users');
    const switcher = page.getByRole('navigation', { name: 'Admin' }).getByRole('button', { name: /^Admin/ });
    await expect(switcher).toHaveAccessibleName(/needs attention/, { timeout: 15_000 });
  });
});
