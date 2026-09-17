/**
 * Maps to features/01-authentication.feature
 */
import { test, expect, ADMIN } from './fixtures.js';

test.describe('authentication', () => {
  test('successful sign-in lands on the home page', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Username').fill(ADMIN.username);
    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => u.pathname === '/');
    // `/` is the front page (router.tsx); the item list moved to /browse. The
    // front page carries no product headline any more - the tenant's masthead
    // and the Updates feed are what identify it - so the root element is the
    // locator, and its colophon (rendered unconditionally, after every region
    // above it) is the proof it rendered rather than errored. The page no
    // longer has a search field of its own; search lives in the header.
    await expect(page.locator('main.Home')).toBeVisible();
    await expect(page.locator('main.Home .SiteFooter')).toBeVisible();
  });

  test('invalid password shows an error and stays on /login', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Username').fill(ADMIN.username);
    await page.getByLabel('Password').fill('wrong');
    await page.getByRole('button', { name: /sign in/i }).click();
    // Still on login route after the failed attempt
    await expect(page).toHaveURL(/\/login/);
  });

  test('unauthenticated visit to / can read public knowledge', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/');
    await expect(page.locator('main.Home')).toBeVisible();
  });

  test('sign-out invalidates the session and redirects to /login', async ({ signedInPage }) => {
    // Sign out is now nested inside the user-chip dropdown in GlobalHeader.
    // Open the menu, then click Sign out.
    await signedInPage.getByRole('button', { name: /user menu for/i }).click();
    await signedInPage.getByRole('button', { name: /sign out|logout/i }).click();
    await expect(signedInPage).toHaveURL(/\/login/, { timeout: 5000 });
    // Public knowledge remains readable after the session ends.
    await signedInPage.goto('/');
    await expect(signedInPage).toHaveURL('/');
    await expect(signedInPage.locator('main.Home')).toBeVisible();

    // Protected areas still require a session.
    await signedInPage.goto('/admin');
    await expect(signedInPage).toHaveURL(/\/login/);
  });
});

test.describe('authentication — API surface', () => {
  test('POST /auth/login returns a session cookie', async ({ apiAsAdmin }) => {
    // The fixture has already logged in successfully; /me must echo the user.
    const res = await apiAsAdmin.get('/api/v1/me');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.user.username).toBe('admin');
    expect(body.user.role).toBe('admin');
  });

  test('change password with wrong old password returns 401', async ({ apiAsAdmin }) => {
    const res = await apiAsAdmin.post('/api/v1/me/password', {
      data: { old_password: 'wrong', new_password: 'doesnt-matter-12' },
    });
    expect(res.status()).toBe(401);
  });
});
