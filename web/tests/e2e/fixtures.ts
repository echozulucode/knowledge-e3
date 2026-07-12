import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test';

/**
 * Shared fixtures for e2e tests.
 *
 * `signedInPage`: a Page that has already signed in as admin.
 * `apiAsAdmin`: an APIRequestContext authenticated as admin (for direct API
 *   calls that don't need the UI).
 */

export const ADMIN = {
  username: 'admin',
  password: 'admin-dev-password',
};

type Fixtures = {
  signedInPage: Page;
  apiAsAdmin: APIRequestContext;
};

export const test = base.extend<Fixtures>({
  signedInPage: async ({ page }, use) => {
    await page.goto('/login');
    await page.getByLabel('Username').fill(ADMIN.username);
    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    // We're either on / (page list) or wherever the app lands post-login.
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 10_000 });
    await use(page);
  },

  apiAsAdmin: async ({ playwright }, use) => {
    // baseURL is the server origin only; tests pass full /api/v1/... paths.
    // (URL resolution treats a leading-slash path as absolute, replacing any
    // pathname embedded in baseURL — so we don't embed /api/v1 there.)
    const ctx = await playwright.request.newContext({
      baseURL: process.env.PLAYWRIGHT_API_BASE_URL ?? 'http://localhost:3001',
    });
    const res = await ctx.post('/api/v1/auth/login', {
      data: { username: ADMIN.username, password: ADMIN.password },
    });
    if (!res.ok()) {
      throw new Error(`API login failed: ${res.status()} ${await res.text()}`);
    }
    await use(ctx);
    await ctx.dispose();
  },
});

export { expect };

/**
 * Convenience: create a page via API and return its slug + id.
 * Avoids the UI bootstrap path when a test just needs a page to exist.
 */
export async function createPageViaApi(
  api: APIRequestContext,
  input: {
    title: string;
    body?: string;
    status?: 'draft' | 'published';
    tags?: string[];
    frontmatter?: Record<string, unknown>;
  },
): Promise<{ id: string; slug: string; version_token: number }> {
  const res = await api.post('/api/v1/pages', {
    data: {
      title: input.title,
      body: input.body ?? '',
      status: input.status ?? 'draft',
      tags: input.tags ?? [],
      frontmatter: input.frontmatter ?? {},
    },
  });
  if (!res.ok()) throw new Error(`createPageViaApi failed: ${res.status()} ${await res.text()}`);
  const body = await res.json();
  return { id: body.page.id, slug: body.page.slug, version_token: body.page.version_token };
}
