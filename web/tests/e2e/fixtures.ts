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
 * Create a non-admin user (via the admin API) and return an APIRequestContext
 * logged in as them. Used to test cross-user visibility — e.g. that another
 * user's draft is excluded from your default search. Username should be unique
 * per test (the DB is wiped per run, not per test).
 */
export async function createUserApiContext(
  playwright: typeof import('@playwright/test').default,
  admin: APIRequestContext,
  opts: { username: string; password?: string; role?: 'user' | 'admin' },
): Promise<APIRequestContext> {
  const password = opts.password ?? 'user-dev-password-123';
  const created = await admin.post('/api/v1/admin/users', {
    data: {
      email: `${opts.username}@example.com`,
      username: opts.username,
      password,
      role: opts.role ?? 'user',
    },
  });
  if (!created.ok() && created.status() !== 409) {
    throw new Error(`createUser failed: ${created.status()} ${await created.text()}`);
  }
  const ctx = await playwright.request.newContext({
    baseURL: process.env.PLAYWRIGHT_API_BASE_URL ?? 'http://localhost:3001',
  });
  const login = await ctx.post('/api/v1/auth/login', { data: { username: opts.username, password } });
  if (!login.ok()) throw new Error(`user login failed: ${login.status()} ${await login.text()}`);
  return ctx;
}

/**
 * The minimum frontmatter the publish gate asks for (issue 98): a `type`, a
 * `description`, and one primary category from the CURATED catalog — here one
 * the e2e seed (`global-setup.ts` → `pnpm --filter server seed`) always creates.
 * A create that lands published without them is refused with 422 `lint_failed`.
 */
export const CONFORMANT_FRONTMATTER: Readonly<Record<string, unknown>> = {
  type: 'Concept',
  description: 'An e2e fixture that satisfies the publish-time rules.',
  categories: ['research-notes'],
};

/**
 * Put primary categories in the curated catalog, the way an admin does before
 * anyone may publish into them (primary categories are curated, not emergent).
 * Pass the display name; the slug is derived from it unless given. Idempotent:
 * an existing slug (409) is fine. Not cleaned up — the DB is wiped per run, an
 * in-use category cannot be archived, and the specs that read the catalog
 * (compose's Publish drawer) compare against the live list rather than a fixed one.
 */
export async function ensureCategories(
  api: APIRequestContext,
  ...categories: Array<string | { name: string; slug: string }>
): Promise<void> {
  for (const category of categories) {
    const data = typeof category === 'string' ? { name: category } : category;
    const res = await api.post('/api/v1/taxonomy/categories', { data });
    if (!res.ok() && res.status() !== 409) {
      throw new Error(`ensureCategories failed for ${data.name}: ${res.status()} ${await res.text()}`);
    }
  }
}

/**
 * The conformant defaults for one published fixture: `CONFORMANT_FRONTMATTER`,
 * plus the two extra keys a published Blog Post must carry (`authors`,
 * `published_at`) when the caller made it one. Caller keys always win.
 */
export function conformantFrontmatter(frontmatter: Record<string, unknown> = {}): Record<string, unknown> {
  const blogPost = String(frontmatter['type'] ?? '').toLowerCase() === 'blog post';
  return {
    ...CONFORMANT_FRONTMATTER,
    ...(blogPost ? { authors: ['E2E Author'], published_at: new Date().toISOString() } : {}),
    ...frontmatter,
  };
}

/**
 * Convenience: create a page via API and return its slug + id.
 * Avoids the UI bootstrap path when a test just needs a page to exist.
 *
 * A published page gets `conformantFrontmatter` underneath the caller's own
 * frontmatter, so a spec that only needs "a published page" gets one the gate
 * accepts. A spec that names its own `categories` must name curated ones.
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
  const status = input.status ?? 'draft';
  const res = await api.post('/api/v1/pages', {
    data: {
      title: input.title,
      body: input.body ?? '',
      status,
      tags: input.tags ?? [],
      frontmatter:
        status === 'published' ? conformantFrontmatter(input.frontmatter) : (input.frontmatter ?? {}),
    },
  });
  if (!res.ok()) throw new Error(`createPageViaApi failed: ${res.status()} ${await res.text()}`);
  const body = await res.json();
  return { id: body.page.id, slug: body.page.slug, version_token: body.page.version_token };
}
