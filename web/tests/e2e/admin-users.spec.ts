import { test, expect, createUserApiContext, ADMIN } from './fixtures.js';
import type { APIRequest, APIRequestContext, Page } from '@playwright/test';

/**
 * Admin → Users (features/01-authentication.feature; the admin UX review §4.3).
 *
 * The list is read-only and server-paged: search, Role and Status filters, sort
 * and page live in the URL. A row opens the user sheet (`?user=<id>`), where the
 * role is saved behind a confirmation and Reset password / Disable / Enable run
 * their own confirm flows. New user is the same sheet in create mode.
 *
 * The rule under test throughout: nothing privileged or destructive commits from
 * a table row, a menu or a radio change. Each test creates its own uniquely named
 * accounts so it never acts on the seeded admin (the DB is wiped per run, not per test).
 */

const API_BASE = process.env.PLAYWRIGHT_API_BASE_URL ?? 'http://localhost:3001';

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}`;
}

type SavedUser = { id: string; username: string; role: string; status: string };

async function savedUser(api: APIRequestContext, username: string): Promise<SavedUser> {
  const res = await api.get(`/api/v1/admin/users?q=${encodeURIComponent(username)}`);
  if (!res.ok()) throw new Error(`list users failed: ${res.status()} ${await res.text()}`);
  const body = (await res.json()) as { users: SavedUser[] };
  const user = body.users.find((u) => u.username === username);
  if (!user) throw new Error(`user ${username} not found`);
  return user;
}

async function createUser(api: APIRequestContext, username: string, role: 'user' | 'admin' = 'user'): Promise<void> {
  const res = await api.post('/api/v1/admin/users', {
    data: { email: `${username}@example.com`, username, password: 'user-dev-password-123', role },
  });
  if (!res.ok() && res.status() !== 409) throw new Error(`create ${username} failed: ${res.status()} ${await res.text()}`);
}

async function canSignIn(playwright: { request: APIRequest }, username: string, password: string): Promise<number> {
  const ctx = await playwright.request.newContext({ baseURL: API_BASE });
  try {
    return (await ctx.post('/api/v1/auth/login', { data: { username, password } })).status();
  } finally {
    await ctx.dispose();
  }
}

/** The Users list filtered to one account, and that account's row. */
async function findRow(page: Page, username: string) {
  await page.goto(`/admin/users?q=${encodeURIComponent(username)}`);
  const row = page.getByRole('row', { name: new RegExp(username) });
  await expect(row).toBeVisible({ timeout: 15_000 });
  return row;
}

/** Open the user sheet from the list, the way an admin does: click the row. */
async function openSheet(page: Page, username: string) {
  const row = await findRow(page, username);
  await row.getByRole('button', { name: new RegExp(username) }).first().click();
  const sheet = page.getByRole('dialog', { name: username, exact: true });
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(/[?&]user=/);
  return sheet;
}

test.describe('Admin → Users list', () => {
  test('search and filters are in the URL, survive a reload, and the list reads only', async ({ signedInPage: page, apiAsAdmin }) => {
    const prefix = uniqueName('e2e-filter');
    await createUser(apiAsAdmin, `${prefix}-ann`, 'admin');
    await createUser(apiAsAdmin, `${prefix}-bea`);

    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/\d+ accounts? · \d+ active admins?/)).toBeVisible();

    await page.getByLabel('Search users').fill(prefix);
    await expect(page).toHaveURL(new RegExp(`[?&]q=${prefix}`));
    await expect(page.getByRole('row', { name: new RegExp(`${prefix}-ann`) })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(`${prefix}-bea`) })).toBeVisible();

    await page.getByLabel('Filter by role').selectOption('admin');
    await expect(page).toHaveURL(/[?&]role=admin/);
    await expect(page.getByRole('row', { name: new RegExp(`${prefix}-bea`) })).toHaveCount(0);
    await expect(page.getByRole('row', { name: new RegExp(`${prefix}-ann`) })).toBeVisible();

    // A shared / reloaded link restores the same view, search box included.
    await page.reload();
    await expect(page.getByLabel('Search users')).toHaveValue(prefix);
    await expect(page.getByLabel('Filter by role')).toHaveValue('admin');
    await expect(page.getByRole('row', { name: new RegExp(`${prefix}-ann`) })).toBeVisible();

    // No inline role select or action buttons on a row any more.
    const row = page.getByRole('row', { name: new RegExp(`${prefix}-ann`) });
    await expect(row.getByRole('combobox')).toHaveCount(0);
    await expect(row.getByRole('button', { name: /^(Disable|Reset password)$/ })).toHaveCount(0);

    await page.getByLabel('Filter by status').selectOption('disabled');
    await expect(page).toHaveURL(/[?&]status=disabled/);
    await expect(page.getByText('No users match')).toBeVisible();

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).not.toHaveURL(/[?&](q|role|status)=/);
  });

  test('pages through a large set on the server: "1–50 of N", Next, and the page in the URL', async ({ signedInPage: page, apiAsAdmin }) => {
    const prefix = uniqueName('e2e-page');
    for (let i = 0; i < 55; i += 1) await createUser(apiAsAdmin, `${prefix}-${String(i).padStart(2, '0')}`);

    await page.goto(`/admin/users?q=${prefix}&sort=username`);
    const pager = page.getByRole('navigation', { name: 'Users pages' });
    await expect(pager).toContainText('1–50 of 55', { timeout: 15_000 });
    await expect(page.getByRole('row', { name: new RegExp(`${prefix}-00`) })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(`${prefix}-54`) })).toHaveCount(0);
    await expect(pager.getByRole('button', { name: 'Previous' })).toBeDisabled();

    await pager.getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL(/[?&]page=2/);
    await expect(pager).toContainText('51–55 of 55');
    await expect(page.getByRole('row', { name: new RegExp(`${prefix}-54`) })).toBeVisible();
    await expect(pager.getByRole('button', { name: 'Next' })).toBeDisabled();

    // Back returns to page 1.
    await page.goBack();
    await expect(pager).toContainText('1–50 of 55');
  });
});

test.describe('Admin → Users sheet', () => {
  test('a role change is saved from the sheet only after confirming; Cancel keeps the saved role', async ({ signedInPage: page, apiAsAdmin, playwright }) => {
    const username = uniqueName('e2e-role');
    const ctx = await createUserApiContext(playwright, apiAsAdmin, { username });
    await ctx.dispose();

    const sheet = await openSheet(page, username);
    const role = sheet.getByRole('group', { name: `Role for ${username}` });
    await expect(role.getByRole('radio', { name: /^User/ })).toBeChecked();
    await expect(sheet.getByRole('button', { name: 'Save' })).toBeDisabled();

    await role.getByRole('radio', { name: /^Admin/ }).check();
    // Picking a radio saves nothing.
    expect((await savedUser(apiAsAdmin, username)).role).toBe('user');

    await sheet.getByRole('button', { name: 'Save' }).click();
    const dialog = page.getByRole('dialog', { name: `Make ${username} an admin?` });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/create, disable and reset other users/i);
    await expect(dialog).toContainText(/authentication/i);
    await expect(dialog).toContainText(/sources/i);
    await expect(dialog).toContainText(/audit/i);
    expect((await savedUser(apiAsAdmin, username)).role).toBe('user');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect((await savedUser(apiAsAdmin, username)).role).toBe('user');

    await sheet.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('dialog', { name: `Make ${username} an admin?` }).getByRole('button', { name: 'Make admin' }).click();
    await expect(page.getByRole('dialog', { name: `Make ${username} an admin?` })).toBeHidden();
    await expect.poll(async () => (await savedUser(apiAsAdmin, username)).role).toBe('admin');
    await expect(role.getByRole('radio', { name: /^Admin/ })).toBeChecked();
    await expect(sheet.getByRole('button', { name: 'Save' })).toBeDisabled();

    // Demotion is a plain confirm.
    await role.getByRole('radio', { name: /^User/ }).check();
    await sheet.getByRole('button', { name: 'Save' }).click();
    const demote = page.getByRole('dialog', { name: `Remove ${username}'s admin role?` });
    await demote.getByRole('button', { name: 'Make user' }).click();
    await expect(demote).toBeHidden();
    await expect.poll(async () => (await savedUser(apiAsAdmin, username)).role).toBe('user');

    // Closing the sheet drops `?user=`.
    await sheet.getByRole('button', { name: `Close ${username}` }).click();
    await expect(sheet).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]user=/);
  });

  test('closing with an unsaved role choice asks to discard it', async ({ signedInPage: page, apiAsAdmin }) => {
    const username = uniqueName('e2e-discard');
    await createUser(apiAsAdmin, username);
    const sheet = await openSheet(page, username);
    await sheet.getByRole('radio', { name: /^Admin/ }).check();
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    const discard = page.getByRole('dialog', { name: 'Discard changes?' });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Discard' }).click();
    await expect(sheet).toBeHidden();
    expect((await savedUser(apiAsAdmin, username)).role).toBe('user');
  });

  test('states the self rule before trying, and shows recent activity with a link to the audit log', async ({ signedInPage: page, apiAsAdmin, playwright }) => {
    // The signed-in admin's own sheet, opened by link (a search for "admin" can
    // match many rows): role and disable are locked, with the reason in text.
    const me = (await (await apiAsAdmin.get('/api/v1/me')).json()) as { user: { id: string } };
    await page.goto(`/admin/users?user=${me.user.id}`);
    const sheet = page.getByRole('dialog', { name: ADMIN.username, exact: true });
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    await expect(sheet).toContainText('You cannot change your own role.');
    await expect(sheet).toContainText('You cannot disable your own account.');
    await expect(sheet.getByRole('radio', { name: /^Admin/ })).toBeDisabled();
    await expect(sheet.getByRole('button', { name: 'Disable account…' })).toBeDisabled();

    // Another account's own activity: minting a token is audited with them as the actor.
    const username = uniqueName('e2e-activity');
    const ctx = await createUserApiContext(playwright, apiAsAdmin, { username });
    try {
      const minted = await ctx.post('/api/v1/me/tokens', { data: { name: `e2e ${username}`, scope: 'read', expires_in_days: 30 } });
      expect(minted.ok()).toBe(true);
    } finally {
      await ctx.dispose();
    }
    const other = await openSheet(page, username);
    await expect(other.getByRole('list', { name: `Recent activity by ${username}` })).toContainText('token.create');
    await expect(other).toContainText(/API tokens: 1 active/);
    await other.getByRole('link', { name: /View all in audit log/ }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/audit\\?actor=${username}`));
  });

  test('Reset password confirms, then shows the temporary password once', async ({ signedInPage: page, apiAsAdmin, playwright }) => {
    const username = uniqueName('e2e-reset');
    await createUser(apiAsAdmin, username);

    const sheet = await openSheet(page, username);
    await sheet.getByRole('button', { name: 'Reset password…' }).click();
    const confirm = page.getByRole('dialog', { name: `Reset ${username}'s password?` });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(/signs .* out of every session/i);
    await confirm.getByRole('button', { name: 'Reset password' }).click();

    const reveal = page.getByRole('dialog', { name: `Temporary password for ${username}` });
    await expect(reveal).toBeVisible();
    await expect(reveal.getByRole('button', { name: /copy/i })).toBeVisible();
    const password = (await reveal.getByLabel(`Temporary password for ${username}`).innerText()).trim();
    expect(password.length).toBeGreaterThan(0);
    expect(await canSignIn(playwright, username, password)).toBe(200);

    await reveal.getByRole('button', { name: 'Done' }).click();
    await expect(reveal).toBeHidden();
    await expect(page.getByText(password)).toHaveCount(0);
  });

  test('Disable lists its consequences and asks first; Enable does not', async ({ signedInPage: page, apiAsAdmin }) => {
    const username = uniqueName('e2e-disable');
    await createUser(apiAsAdmin, username);

    const sheet = await openSheet(page, username);
    await sheet.getByRole('button', { name: 'Disable account…' }).click();
    const dialog = page.getByRole('dialog', { name: `Disable ${username}?` });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/signing in/i);
    await expect(dialog).toContainText(/sessions/i);
    await expect(dialog).toContainText(/API tokens/i);

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect((await savedUser(apiAsAdmin, username)).status).toBe('active');

    // Esc closes only the innermost layer: the confirmation, not the sheet under it.
    await sheet.getByRole('button', { name: 'Disable account…' }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(sheet).toBeVisible();

    await sheet.getByRole('button', { name: 'Disable account…' }).click();
    await page.getByRole('dialog', { name: `Disable ${username}?` }).getByRole('button', { name: 'Disable account' }).click();
    await expect(page.getByRole('dialog', { name: `Disable ${username}?` })).toBeHidden();
    await expect.poll(async () => (await savedUser(apiAsAdmin, username)).status).toBe('disabled');
    await expect(sheet).toContainText('Disabled');

    // Re-enabling restores access, the reversible direction: no confirmation.
    await sheet.getByRole('button', { name: 'Enable account' }).click();
    await expect(page.getByRole('dialog', { name: `Disable ${username}?` })).toHaveCount(0);
    await expect.poll(async () => (await savedUser(apiAsAdmin, username)).status).toBe('active');
  });

  test('the row menu offers the same confirmed actions', async ({ signedInPage: page, apiAsAdmin }) => {
    const username = uniqueName('e2e-menu');
    await createUser(apiAsAdmin, username);

    const row = await findRow(page, username);
    await row.getByRole('button', { name: `Actions for ${username}` }).click();
    await page.getByRole('menuitem', { name: 'Disable…' }).click();
    const dialog = page.getByRole('dialog', { name: `Disable ${username}?` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect((await savedUser(apiAsAdmin, username)).status).toBe('active');

    await row.getByRole('button', { name: `Actions for ${username}` }).click();
    await page.getByRole('menuitem', { name: 'View activity in audit log' }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/audit\\?actor=${username}`));
  });
});

test.describe('Admin → New user', () => {
  test('Generate fills a password that meets the policy, and it is revealed once after creation', async ({ signedInPage: page, apiAsAdmin, playwright }) => {
    const username = uniqueName('e2e-new');
    await page.goto('/admin/users');
    await page.getByRole('button', { name: 'New user' }).click();
    await expect(page).toHaveURL(/[?&]new=1/);
    const sheet = page.getByRole('dialog', { name: 'New user' });
    await expect(sheet).toBeVisible();

    await sheet.getByLabel('Username').fill(username);
    await sheet.getByLabel('Email').fill(`${username}@example.com`);
    const checklist = sheet.getByRole('list', { name: 'Password requirements' });
    await expect(checklist).toContainText(/At least \d+ characters/);
    await expect(sheet.getByRole('button', { name: 'Create user' })).toBeDisabled();

    // Typing a short password: the checklist says what is missing.
    await sheet.locator('#new-user-password').fill('short');
    await expect(checklist.getByRole('listitem').first()).toContainText('(not yet)');

    await sheet.getByRole('button', { name: 'Generate' }).click();
    await expect(checklist.getByText('(not yet)')).toHaveCount(0);
    await expect(sheet.locator('#new-user-password')).toHaveAttribute('type', 'password');
    await sheet.getByRole('button', { name: 'Show' }).click();
    await expect(sheet.locator('#new-user-password')).toHaveAttribute('type', 'text');

    await sheet.getByRole('button', { name: 'Create user' }).click();
    const reveal = page.getByRole('dialog', { name: `Password for ${username}` });
    await expect(reveal).toBeVisible();
    await expect(sheet).toBeHidden();
    const password = (await reveal.getByLabel(`Password for ${username}`).innerText()).trim();
    expect(await canSignIn(playwright, username, password)).toBe(200);
    await reveal.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText(password)).toHaveCount(0);
    expect((await savedUser(apiAsAdmin, username)).role).toBe('user');
  });

  test('a duplicate username is reported under the Username field', async ({ signedInPage: page, apiAsAdmin }) => {
    const username = uniqueName('e2e-dup');
    await createUser(apiAsAdmin, username);

    await page.goto('/admin/users?new=1');
    const sheet = page.getByRole('dialog', { name: 'New user' });
    await sheet.getByLabel('Username').fill(username);
    await sheet.getByLabel('Email').fill(`other-${username}@example.com`);
    await sheet.getByRole('button', { name: 'Generate' }).click();
    await sheet.getByRole('button', { name: 'Create user' }).click();
    await expect(sheet.getByLabel('Username')).toHaveAttribute('aria-invalid', 'true');
    await expect(sheet).toContainText('A user with that username already exists.');
    // Nothing was revealed: the account was not created.
    await expect(page.getByRole('dialog', { name: `Password for ${username}` })).toHaveCount(0);
  });
});

test.describe('Admin → Users on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('rows are cards with a menu, and the sheet fills the screen with its actions reachable', async ({ signedInPage: page, apiAsAdmin }) => {
    const username = uniqueName('e2e-phone');
    await createUser(apiAsAdmin, username);

    const row = await findRow(page, username);
    // Cards, not a sideways-scrolling table: the row fits the viewport.
    await expect.poll(async () => (await row.boundingBox())?.width ?? 9999).toBeLessThanOrEqual(390);
    await expect(row.getByRole('button', { name: `Actions for ${username}` })).toBeInViewport();

    const sheet = await openSheet(page, username);
    const box = await sheet.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(385);

    for (const name of ['Reset password…', 'Disable account…']) {
      const button = sheet.getByRole('button', { name });
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport();
    }
    await sheet.getByRole('button', { name: 'Disable account…' }).click();
    const dialog = page.getByRole('dialog', { name: `Disable ${username}?` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });
});
