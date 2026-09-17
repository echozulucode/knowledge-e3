import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures.js';
import type { APIRequest, APIRequestContext, Page } from '@playwright/test';

/**
 * Admin → Audit (features/07-audit-and-telemetry.feature;
 * the admin UX review §2 #10 and §4.8).
 *
 * A failed sign-in has no actor - the server keeps `actor_id` null on purpose,
 * so the row cannot say whether the account exists - but it was a person at the
 * login form, not the product. The row reads `(anonymous)` with the name that
 * was tried in the summary, never "system".
 *
 * Every filter applies the moment it changes and lives in the URL. The browser
 * runs in a zone west of UTC so the local day and the UTC day differ for part
 * of every day: a custom From/To must still include a row whose local date is
 * the day picked.
 *
 * Each test makes its own uniquely named accounts and rows (the DB is wiped per
 * run, not per test).
 */
test.use({ timezoneId: 'America/Los_Angeles' });

const API_BASE = process.env.PLAYWRIGHT_API_BASE_URL ?? 'http://localhost:3001';

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}`;
}

/** A sign-in attempt from a stranger with no session. Returns the (lowercase) name tried. */
async function failSignIn(playwright: { request: APIRequest }, prefix: string): Promise<string> {
  // Lowercase: the server records the attempted name normalised.
  const attempted = uniqueName(prefix);
  const stranger = await playwright.request.newContext({ baseURL: API_BASE });
  try {
    const res = await stranger.post('/api/v1/auth/login', { data: { username: attempted, password: 'definitely-not-the-password' } });
    expect(res.status()).toBe(401);
  } finally {
    await stranger.dispose();
  }
  return attempted;
}

/** An account the admin then promotes: a `user.role_change` row whose subject is that account. */
async function promotedUser(api: APIRequestContext, prefix: string): Promise<{ id: string; username: string }> {
  const username = uniqueName(prefix);
  const created = await api.post('/api/v1/admin/users', {
    data: { email: `${username}@example.com`, username, password: 'user-dev-password-123', role: 'user' },
  });
  expect(created.ok()).toBe(true);
  const { user } = (await created.json()) as { user: { id: string } };
  const patched = await api.patch(`/api/v1/admin/users/${user.id}`, { data: { role: 'admin' } });
  expect(patched.ok()).toBe(true);
  return { id: user.id, username };
}

/** The entry row (not its expanded detail) whose text matches. */
function entryRow(page: Page, text: string | RegExp) {
  return page.locator('tr.AdminAudit__row', { hasText: text });
}

test.describe('Admin → Audit', () => {
  test('a failed sign-in is shown as (anonymous) with the attempted username in the summary', async ({ signedInPage: page, playwright }) => {
    const attempted = await failSignIn(playwright, 'e2e-ghost');

    await page.goto('/admin/audit?action=auth.login_failed');
    const row = entryRow(page, attempted);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByRole('cell').nth(1)).toHaveText('(anonymous)');
    await expect(row.getByRole('cell').nth(2)).toHaveText('auth.login_failed');
    await expect(row.getByRole('cell').nth(3)).toContainText(`as "${attempted}"`);
    await expect(row).not.toContainText('system');
  });

  test('filters apply immediately, show as chips, and survive a reload', async ({ signedInPage: page, playwright }) => {
    const attempted = await failSignIn(playwright, 'e2e-filters');

    await page.goto('/admin/audit');
    await expect(page.getByRole('heading', { level: 1, name: 'Audit' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Times in your timezone \(UTC[−+]\d/)).toBeVisible();
    // No Apply button: a change IS the filter.
    await expect(page.getByRole('button', { name: 'Apply' })).toHaveCount(0);

    await page.getByLabel('Action', { exact: true }).selectOption('auth.login_failed');
    await expect(page).toHaveURL(/[?&]action=auth\.login_failed/);
    await page.getByLabel('When', { exact: true }).selectOption('24h');
    await expect(page).toHaveURL(/[?&]range=24h/);
    await expect(entryRow(page, attempted)).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Action', { exact: true })).toHaveValue('auth.login_failed', { timeout: 15_000 });
    await expect(page.getByLabel('When', { exact: true })).toHaveValue('24h');
    const active = page.getByRole('group', { name: 'Active filters' });
    await expect(active.getByRole('button', { name: 'Remove action filter: auth.login_failed' })).toBeVisible();
    await expect(active.getByRole('button', { name: 'Remove when filter: last 24 hours' })).toBeVisible();
    await expect(entryRow(page, attempted)).toBeVisible();

    await active.getByRole('button', { name: /Remove action filter/ }).click();
    await expect(page).not.toHaveURL(/action=/);
    await expect(page).toHaveURL(/[?&]range=24h/);

    await active.getByRole('button', { name: 'Clear all' }).click();
    await expect(page).toHaveURL(/\/admin\/audit$/);
    await expect(page.getByRole('group', { name: 'Active filters' })).toHaveCount(0);
  });

  test('a custom From/To uses local days, and today includes a row written now', async ({ signedInPage: page, playwright }) => {
    const attempted = await failSignIn(playwright, 'e2e-window');

    await page.goto('/admin/audit?action=auth.login_failed');
    await page.getByLabel('When', { exact: true }).selectOption('custom');

    // Today as the browser (Los Angeles) sees it, in the date input's format.
    const today = await page.evaluate(() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    await page.getByLabel('From', { exact: true }).fill(today);
    await page.getByLabel('To', { exact: true }).fill(today);
    await expect(page).toHaveURL(new RegExp(`until=${today}`));
    await expect(entryRow(page, attempted)).toBeVisible();
  });

  test('the Users panel links to what was done to an account (subject)', async ({ signedInPage: page, apiAsAdmin }) => {
    const { username } = await promotedUser(apiAsAdmin, 'e2e-subject');

    await page.goto(`/admin/users?q=${encodeURIComponent(username)}`);
    const userRow = page.getByRole('row', { name: new RegExp(username) });
    await expect(userRow).toBeVisible({ timeout: 15_000 });
    await userRow.getByRole('button', { name: new RegExp(username) }).first().click();
    const sheet = page.getByRole('dialog', { name: username, exact: true });
    await sheet.getByRole('link', { name: /Changes to this account/ }).click();

    await expect(page).toHaveURL(new RegExp(`/admin/audit\\?subject=${username}`));
    const row = entryRow(page, `${username}: user → admin`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByRole('cell').nth(1)).toHaveText('admin');
    await expect(row.getByRole('cell').nth(2)).toHaveText('user.role_change');
    await expect(page.getByRole('group', { name: 'Active filters' }).getByRole('button', { name: `Remove subject filter: ${username}` })).toBeVisible();
  });

  test('a row expands to its detail: filter links, exact times, payload JSON with Copy JSON and Copy link', async ({ signedInPage: page, apiAsAdmin, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const { id, username } = await promotedUser(apiAsAdmin, 'e2e-expand');

    await page.goto(`/admin/audit?subject=${username}&action=user.role_change`);
    const row = entryRow(page, username);
    await expect(row).toBeVisible({ timeout: 15_000 });
    const toggle = row.getByRole('button').first();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const detail = page.getByRole('region', { name: /^Entry \d+ details$/ });
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Filter by actor' })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Filter by subject' })).toBeVisible();
    await expect(detail).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(.*UTC\)/);
    const json = detail.getByLabel('Payload JSON');
    await expect(json).toContainText(`"user_id": "${id}"`);
    await expect(json).toContainText('"to": "admin"');

    await detail.getByRole('button', { name: 'Copy JSON' }).click();
    await expect(page.getByText('Payload JSON copied.')).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(JSON.parse(copied)).toMatchObject({ user_id: id, from: 'user', to: 'admin' });

    await detail.getByRole('button', { name: 'Copy link' }).click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toMatch(/\/admin\/audit\?entry=\d+$/);

    // The link opens that one entry, already expanded.
    await page.goto(link);
    await expect(page.locator('tr.AdminAudit__row')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByRole('region', { name: /^Entry \d+ details$/ })).toContainText('"to": "admin"');

    // Filter by actor leaves the single-entry view for the actor's rows.
    await page.getByRole('button', { name: 'Filter by actor' }).click();
    await expect(page).toHaveURL(/[?&]actor=admin/);
    await expect(page).not.toHaveURL(/entry=/);
  });

  test('Export downloads the filtered rows as CSV and JSON', async ({ signedInPage: page, apiAsAdmin }) => {
    const { username } = await promotedUser(apiAsAdmin, 'e2e-export');
    await page.goto(`/admin/audit?subject=${username}&action=user.role_change`);
    await expect(entryRow(page, username)).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /^Export/ }).click();
    const [csvDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export as CSV' }).click()]);
    expect(csvDownload.suggestedFilename()).toMatch(/^audit-.*\.csv$/);
    const csv = await readFile((await csvDownload.path())!, 'utf8');
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('id,occurred_at_utc,actor,actor_id,action,summary,subject,item_id,item_title,payload');
    // Exactly the filtered result: one row.
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`,user.role_change,${username}: user → admin,${username},`);

    await page.getByRole('button', { name: /^Export/ }).click();
    const [jsonDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export as JSON' }).click()]);
    expect(jsonDownload.suggestedFilename()).toMatch(/^audit-.*\.json$/);
    const body = JSON.parse(await readFile((await jsonDownload.path())!, 'utf8')) as {
      count: number;
      capped: boolean;
      filters: Record<string, string>;
      entries: { action: string; summary: string }[];
    };
    expect(body).toMatchObject({ count: 1, capped: false, filters: { subject: username, action: 'user.role_change' } });
    expect(body.entries[0]).toMatchObject({ action: 'user.role_change', summary: `${username}: user → admin` });
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('entries are cards, and the page never scrolls sideways', async ({ signedInPage: page, playwright }) => {
      const attempted = await failSignIn(playwright, 'e2e-phone');
      await page.goto('/admin/audit?action=auth.login_failed');
      const row = entryRow(page, attempted);
      await expect(row).toBeVisible({ timeout: 15_000 });

      // Cards: no column header row, each field labelled in the card.
      await expect(page.locator('.AdminAudit__table thead')).toBeHidden();
      const label = await row
        .locator('td[data-label="Actor"]')
        .evaluate((td) => getComputedStyle(td, '::before').content);
      expect(label).toBe('"Actor"');

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);

      await row.getByRole('button').first().click();
      await expect(page.getByRole('region', { name: /^Entry \d+ details$/ })).toContainText('username_attempted');
    });
  });
});
