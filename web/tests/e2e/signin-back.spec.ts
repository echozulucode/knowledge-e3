import { test, expect } from './fixtures.js';

/**
 * Sign-in offers a way back (Eric, 2026-09-14): "If I don't have a sign in, I just want to get
 * back to what I can access easily" - without editing the URL. The e2e instance is publicly
 * readable (the default), so both links are offered and lead to the front page.
 */
test.describe('sign-in page, as an anonymous visitor on a publicly readable library', () => {
  test('"Back to home" returns to the front page', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await page.getByRole('link', { name: 'Back to home' }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/');
    await expect(page.locator('main.Home')).toBeVisible();
    await context.close();
  });

  test('"Continue without signing in" also returns to the front page', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/login');
    await page.getByRole('link', { name: 'Continue without signing in' }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/');
    await context.close();
  });
});
