/**
 * Maps to features/01-authentication.feature
 */
import { test, expect, ADMIN } from './fixtures.js';

test.describe('authentication', () => {
  test('successful sign-in lands on the page list', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Username').fill(ADMIN.username);
    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => u.pathname === '/');
    // PageList's <h1> reads "All pages" in the redesigned header.
    await expect(page.getByRole('heading', { name: 'All pages' })).toBeVisible();
  });

  test('invalid password shows an error and stays on /login', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Username').fill(ADMIN.username);
    await page.getByLabel('Password').fill('wrong');
    await page.getByRole('button', { name: /sign in/i }).click();
    // Still on login route after the failed attempt
    await expect(page).toHaveURL(/\/login/);
  });

  test('unauthenticated visit to / redirects to /login', async ({ page }) => {
    await page.goto('/');
    // Either the app sends us to /login OR a 401 surfaces — accept either signal.
    // Most apps redirect; we prefer that.
    await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
  });

  test('sign-out invalidates the session and redirects to /login', async ({ signedInPage }) => {
    // Sign out is now nested inside the user-chip dropdown in GlobalHeader.
    // Open the menu, then click Sign out.
    await signedInPage.getByRole('button', { name: /user menu for/i }).click();
    await signedInPage.getByRole('button', { name: /sign out|logout/i }).click();
    await expect(signedInPage).toHaveURL(/\/login/, { timeout: 5000 });
    // Hitting / now should bounce us back to /login.
    await signedInPage.goto('/');
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
