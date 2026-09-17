import { test, expect, createUserApiContext } from './fixtures.js';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * Admin → Authentication → API tokens (`/admin/auth/tokens`;
 * features/01-authentication.feature; the admin UX review §4.7).
 *
 * Every user's tokens on their own server-paged page: filters in the URL,
 * Revoke behind a confirmation in the row menu, a live token of a disabled
 * owner shown as "Owner disabled", and never any part of a secret. Each test
 * mints tokens for its own uniquely named account (the DB is wiped per run,
 * not per test), so filtering by that owner isolates what it asserts on.
 */

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

type Minted = { id: string; token: string; name: string };

async function mint(api: APIRequestContext, name: string, scope: 'read' | 'write' = 'read'): Promise<Minted> {
  const res = await api.post('/api/v1/me/tokens', { data: { name, scope, expires_in_days: 30 } });
  if (!res.ok()) throw new Error(`mint failed: ${res.status()} ${await res.text()}`);
  const body = (await res.json()) as { id: string; token: string };
  return { ...body, name };
}

async function userId(api: APIRequestContext): Promise<string> {
  const me = await api.get('/api/v1/me');
  return ((await me.json()) as { user: { id: string } }).user.id;
}

/** Everything a token must never leave on the page. */
async function expectNoSecrets(page: Page, tokens: Minted[]) {
  const text = await page.locator('main').innerText();
  expect(text).not.toContain('e3_');
  for (const t of tokens) {
    expect(text).not.toContain(t.token);
    expect(text).not.toContain(t.token.slice(0, 8));
  }
  await expect(page.getByRole('columnheader', { name: /^(Token|Prefix)$/ })).toHaveCount(0);
}

test.describe('Admin → API tokens', () => {
  test('lists tokens with owner, scope and status, and no part of any secret', async ({ signedInPage: page, apiAsAdmin, playwright }) => {
    const owner = uniqueName('e2e-tok');
    const ctx = await createUserApiContext(playwright, apiAsAdmin, { username: owner });
    try {
      const minted = [await mint(ctx, `${owner} laptop`, 'read'), await mint(ctx, `${owner} ci`, 'write')];
      await page.goto(`/admin/auth/tokens?owner=${owner}`);
      await expect(page.getByRole('heading', { level: 1, name: 'API tokens' })).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('.kp-admin-header__meta')).toContainText(/\d+ tokens? · \d+ active/);

      for (const header of ['Name', 'Owner', 'Scope', 'Expires', 'Status']) {
        await expect(page.getByRole('columnheader', { name: header })).toBeVisible();
      }
      const ci = page.getByRole('row', { name: new RegExp(`${owner} ci`) });
      await expect(ci).toContainText(owner);
      await expect(ci).toContainText('Write');
      await expect(ci).toContainText('Active');
      await expect(page.getByRole('row', { name: new RegExp(`${owner} laptop`) })).toContainText('Read');
      await expectNoSecrets(page, minted);
    } finally {
      await ctx.dispose();
    }
  });

  test('filters by owner, state, scope and name, and keeps them in the address', async ({ signedInPage: page, apiAsAdmin, playwright }) => {
    const owner = uniqueName('e2e-tokf');
    const ctx = await createUserApiContext(playwright, apiAsAdmin, { username: owner });
    try {
      await mint(ctx, `${owner} alpha`, 'read');
      const beta = await mint(ctx, `${owner} beta`, 'write');
      await ctx.delete(`/api/v1/me/tokens/${beta.id}`);

      await page.goto('/admin/auth/tokens');
      // Owner through the picker, the way an admin does.
      const picker = page.getByRole('combobox', { name: 'Filter by owner' });
      await picker.fill(owner);
      await page.getByRole('option', { name: new RegExp(owner) }).click();
      await expect(page).toHaveURL(new RegExp(`[?&]owner=${owner}`));
      await expect(page.getByRole('row', { name: new RegExp(`${owner} alpha`) })).toBeVisible();
      await expect(page.getByRole('row', { name: new RegExp(`${owner} beta`) })).toBeVisible();

      await page.getByRole('combobox', { name: 'Filter by state' }).selectOption('revoked');
      await expect(page).toHaveURL(/[?&]state=revoked/);
      await expect(page.getByRole('row', { name: new RegExp(`${owner} beta`) })).toContainText('Revoked');
      await expect(page.getByRole('row', { name: new RegExp(`${owner} alpha`) })).toHaveCount(0);

      await page.getByRole('combobox', { name: 'Filter by state' }).selectOption('');
      await page.getByRole('combobox', { name: 'Filter by scope' }).selectOption('read');
      await expect(page).toHaveURL(/[?&]scope=read/);
      await expect(page.getByRole('row', { name: new RegExp(`${owner} beta`) })).toHaveCount(0);

      await page.getByRole('combobox', { name: 'Filter by scope' }).selectOption('');
      await page.getByRole('searchbox', { name: 'Search token name' }).fill('beta');
      await expect(page).toHaveURL(/[?&]q=beta/);
      await expect(page.getByRole('row', { name: new RegExp(`${owner} alpha`) })).toHaveCount(0);

      // The address alone reproduces the list.
      const url = page.url();
      await page.goto(url);
      await expect(page.getByRole('row', { name: new RegExp(`${owner} beta`) })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('row', { name: new RegExp(`${owner} alpha`) })).toHaveCount(0);

      await page.getByRole('button', { name: 'Clear filters' }).click();
      await expect(page).toHaveURL(/\/admin\/auth\/tokens$/);
    } finally {
      await ctx.dispose();
    }
  });

  test('pages 50 tokens at a time with the total', async ({ signedInPage: page, apiAsAdmin, playwright }) => {
    const owner = uniqueName('e2e-tokp');
    const ctx = await createUserApiContext(playwright, apiAsAdmin, { username: owner });
    try {
      for (let batch = 0; batch < 51; batch += 10) {
        await Promise.all(
          Array.from({ length: Math.min(10, 51 - batch) }, (_, i) => mint(ctx, `${owner} #${batch + i}`)),
        );
      }
      await page.goto(`/admin/auth/tokens?owner=${owner}`);
      const pager = page.getByRole('navigation', { name: 'Token pages' });
      await expect(pager).toContainText('1–50 of 51', { timeout: 15_000 });
      await expect(page.getByRole('row', { name: new RegExp(`${owner} #`) })).toHaveCount(50);
      await pager.getByRole('button', { name: 'Next' }).click();
      await expect(page).toHaveURL(/[?&]page=2/);
      await expect(pager).toContainText('51–51 of 51');
      await expect(page.getByRole('row', { name: new RegExp(`${owner} #`) })).toHaveCount(1);
      await expect(pager.getByRole('button', { name: 'Next' })).toBeDisabled();
    } finally {
      await ctx.dispose();
    }
  });

  test('Revoke asks first, says the token stops working, and is unavailable once revoked', async ({ signedInPage: page, apiAsAdmin, playwright }) => {
    const owner = uniqueName('e2e-tokr');
    const ctx = await createUserApiContext(playwright, apiAsAdmin, { username: owner });
    try {
      const minted = await mint(ctx, `${owner} agent`, 'write');
      await page.goto(`/admin/auth/tokens?owner=${owner}`);
      const row = page.getByRole('row', { name: new RegExp(`${owner} agent`) });
      await expect(row).toContainText('Active', { timeout: 15_000 });

      const actions = row.getByRole('button', { name: `Actions for ${owner} agent (${owner})` });
      await actions.click();
      await page.getByRole('menuitem', { name: 'Revoke…' }).click();
      const dialog = page.getByRole('dialog', { name: `Revoke “${owner} agent”?` });
      await expect(dialog).toContainText(/stops working immediately/i);
      await expect(dialog).toContainText(/fails on its next request/i);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      await expect(row).toContainText('Active');

      await actions.click();
      await page.getByRole('menuitem', { name: 'Revoke…' }).click();
      await page.getByRole('dialog', { name: `Revoke “${owner} agent”?` }).getByRole('button', { name: 'Revoke token' }).click();
      await expect(row).toContainText('Revoked');

      // The token no longer signs in.
      const bearer = await playwright.request.newContext({ baseURL: process.env.PLAYWRIGHT_API_BASE_URL ?? 'http://localhost:3001' });
      try {
        expect((await bearer.get('/api/v1/me', { headers: { Authorization: `Bearer ${minted.token}` } })).status()).toBe(401);
      } finally {
        await bearer.dispose();
      }

      // Revoke is disabled, with the reason as text.
      await actions.click();
      const revoke = page.getByRole('menuitem', { name: /Revoke…/ });
      await expect(revoke).toBeDisabled();
      await expect(page.getByText('Already revoked.')).toBeVisible();
      await page.keyboard.press('Escape');

      // "View owner's activity in Audit" opens the log filtered to the owner.
      await actions.click();
      await page.getByRole('menuitem', { name: 'View owner’s activity in Audit' }).click();
      await expect(page).toHaveURL(new RegExp(`/admin/audit\\?.*actor=${owner}`));
      await expectNoSecrets(page, [minted]);
    } finally {
      await ctx.dispose();
    }
  });

  test('a live token of a disabled owner shows "Owner disabled", not Active', async ({ signedInPage: page, apiAsAdmin, playwright }) => {
    const owner = uniqueName('e2e-tokd');
    const ctx = await createUserApiContext(playwright, apiAsAdmin, { username: owner });
    let id = '';
    try {
      const minted = await mint(ctx, `${owner} owner-disabled`);
      id = await userId(ctx);
      const disabled = await apiAsAdmin.patch(`/api/v1/admin/users/${id}`, { data: { disabled: true } });
      if (!disabled.ok()) throw new Error(`disable failed: ${disabled.status()} ${await disabled.text()}`);

      await page.goto(`/admin/auth/tokens?owner=${owner}`);
      const row = page.getByRole('row', { name: new RegExp(`${owner} owner-disabled`) });
      await expect(row).toContainText('Owner disabled', { timeout: 15_000 });
      await expect(row).not.toContainText(/\bactive\b/i);

      // And it is what the state filter calls it.
      await page.goto(`/admin/auth/tokens?owner=${owner}&state=owner_disabled`);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await page.goto(`/admin/auth/tokens?owner=${owner}&state=active`);
      await expect(page.getByText('No tokens match')).toBeVisible({ timeout: 15_000 });
      await expectNoSecrets(page, [minted]);
    } finally {
      await ctx.dispose();
      if (id) await apiAsAdmin.patch(`/api/v1/admin/users/${id}`, { data: { disabled: false } });
    }
  });

  test('the admin nav lights API tokens under Authentication', async ({ signedInPage: page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/admin/auth/tokens');
    const nav = page.getByRole('navigation', { name: 'Admin' });
    const auth = nav.getByRole('list', { name: 'Authentication' });
    await expect(auth.getByRole('link', { name: 'API tokens' })).toHaveAttribute('aria-current', 'page', { timeout: 15_000 });
    await expect(auth.getByRole('link', { name: 'Authentication', exact: true })).not.toHaveAttribute('aria-current', 'page');
    await expect(nav.locator('[aria-current="page"]:visible')).toHaveCount(1);

    await auth.getByRole('link', { name: 'Authentication', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/auth$/);
    await expect(auth.getByRole('link', { name: 'Authentication', exact: true })).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('Admin → API tokens on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('rows are cards with their menu in reach', async ({ signedInPage: page, apiAsAdmin, playwright }) => {
    const owner = uniqueName('e2e-tokm');
    const ctx = await createUserApiContext(playwright, apiAsAdmin, { username: owner });
    try {
      const minted = await mint(ctx, `${owner} phone`);
      await page.goto(`/admin/auth/tokens?owner=${owner}`);
      const row = page.getByRole('row', { name: new RegExp(`${owner} phone`) });
      await expect(row).toBeVisible({ timeout: 15_000 });
      // Cards, not a sideways-scrolling table: the row fits the viewport.
      await expect.poll(async () => (await row.boundingBox())?.width ?? 9999).toBeLessThanOrEqual(390);
      await expect(row).toContainText('Active');
      await expect(row.getByRole('button', { name: `Actions for ${owner} phone (${owner})` })).toBeInViewport();
      await expectNoSecrets(page, [minted]);
    } finally {
      await ctx.dispose();
    }
  });
});
