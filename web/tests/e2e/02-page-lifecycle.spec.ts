/**
 * Maps to features/02-page-lifecycle.feature
 *
 * The most important test in this file is the bootstrap one — "create a page
 * from the UI". That's the user-flagged gap that caused this whole
 * test-driven pivot.
 */
import { test, expect, createPageViaApi } from './fixtures.js';

test.describe('page lifecycle — UI', () => {
  test('signed-in user can create a page from the page list', async ({ signedInPage, page }) => {
    void page; // Use the signedInPage fixture; the bare page is unused here.
    // Explicit goto so first-load Vite transpilation is fully done before
    // we look for the button.
    await signedInPage.goto('/browse');
    // New item creation now uses an in-app composer rather than browser prompt().
    signedInPage.on('dialog', (dialog) => {
      throw new Error(`Page creation should not open a browser ${dialog.type()} dialog.`);
    });
    // The redesigned PageList renders the "+ New item" button in BOTH the
    // header and the empty-state CTA. `.first()` consistently picks the
    // header button.
    const newPageButton = signedInPage.getByRole('button', { name: /\+ new item/i }).first();
    await expect(newPageButton).toBeVisible({ timeout: 15_000 });
    await newPageButton.click();
    const composer = signedInPage.getByRole('dialog', { name: /new item composer/i });
    await expect(composer).toBeVisible();
    await composer.getByLabel(/^title/i).fill('Hello From Test');
    await composer.getByRole('button', { name: /start draft/i }).click();
    await signedInPage.waitForURL(/\/p\/hello-from-test/, { timeout: 10_000 });
    // Newly-created pages auto-open in edit mode, where the title hero is
    // rendered as a focused <input> (not a static h1). Assert the input has
    // the right value rather than looking for the read-mode heading.
    const titleInput = signedInPage.getByRole('textbox', { name: 'Title', exact: true });
    await expect(titleInput).toHaveValue('Hello From Test');
  });

  test('page list shows status filter pills and renders both draft and published pages', async ({ signedInPage, apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, { title: 'A Public Doc', status: 'published' });
    await createPageViaApi(apiAsAdmin, { title: 'A Draft Doc', status: 'draft' });
    await signedInPage.goto('/browse');
    // Status filtering lives in the "Filters" facet sidebar. Each facet button's
    // accessible name is "<label> <count>" (label + count spans), so match on a
    // prefix rather than an exact string.
    const filters = signedInPage.getByRole('complementary', { name: 'Filters' });
    await expect(filters.getByRole('button', { name: /^Published\b/ })).toBeVisible();
    await expect(filters.getByRole('button', { name: /^Draft\b/ })).toBeVisible();
    // Page rows are now `<li role="button">` clickable rows (not anchor tags).
    // The accessible name is the page title.
    await expect(signedInPage.locator('.PageList__Card').filter({ has: signedInPage.locator('.PageList__CardTitle', { hasText: 'A Public Doc' }) })).toBeVisible();
    await expect(signedInPage.locator('.PageList__Card').filter({ has: signedInPage.locator('.PageList__CardTitle', { hasText: 'A Draft Doc' }) })).toBeVisible();
  });

  test('reload after save shows the updated body', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Reloadable',
      body: 'first draft',
      status: 'draft',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();
    const editor = signedInPage.locator('.cm-content, .ProseMirror').first();
    await editor.click();
    await editor.press('Control+End');
    await editor.type(' — appended after save');

    const putReq = signedInPage.waitForRequest(
      (req) => req.method() === 'PUT' && req.url().includes(`/api/v1/pages/${p.id}`),
    );
    await signedInPage.getByRole('button', { name: /^save$/i }).first().click();
    await putReq;

    // Hard reload — fresh GET from server, no cached state.
    await signedInPage.goto(`/p/${p.slug}`);
    await expect(signedInPage.getByText(/appended after save/i)).toBeVisible({ timeout: 15_000 });
  });

  test('clicking a page navigates to /p/<slug> and renders the body', async ({ signedInPage, apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, {
      title: 'Readable Page',
      body: 'This is the body content.',
      status: 'published',
    });
    await signedInPage.goto('/browse');
    // The card is a semantic container with an inner "Open <title>" button as
    // its primary action (see list-card-semantics.spec.ts) — the card element
    // itself is no longer the click target.
    const card = signedInPage.locator('.PageList__Card').filter({ has: signedInPage.locator('.PageList__CardTitle', { hasText: 'Readable Page' }) });
    await expect(card).toBeVisible({ timeout: 15_000 });
    // The open action is an overlay button that the card's preview text sits on
    // top of, so a real pointer click is intercepted. Drive it by keyboard, the
    // same way list-card-semantics.spec.ts does.
    await card.getByRole('button', { name: /open readable page/i }).focus();
    await signedInPage.keyboard.press('Enter');
    await signedInPage.waitForURL(/\/p\/readable-page/);
    await expect(signedInPage.getByText('This is the body content.')).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('page lifecycle — API', () => {
  test('duplicate title in the same topic is rejected with 409', async ({ apiAsAdmin }) => {
    // assertTitleAvailableInSpace (pages.service.ts) guards this: an identical
    // title in the same space is a conflict, not a silent second item.
    await createPageViaApi(apiAsAdmin, { title: 'Same Title' });
    const dup = await apiAsAdmin.post('/api/v1/pages', {
      data: { title: 'Same Title', body: '', status: 'draft', tags: [], frontmatter: {} },
    });
    expect(dup.status()).toBe(409);
  });

  test('slug collision auto-disambiguates with -2 suffix', async ({ apiAsAdmin }) => {
    // Distinct titles that slugify identically ("!" is stripped) still collide
    // on slug, so findFreeSlug's -2 suffix remains reachable. Identical titles
    // no longer are — they are rejected by the duplicate-title guard above.
    const a = await createPageViaApi(apiAsAdmin, { title: 'Slug Collide' });
    const b = await createPageViaApi(apiAsAdmin, { title: 'Slug Collide!' });
    expect(a.slug).toBe('slug-collide');
    expect(b.slug).toBe('slug-collide-2');
  });

  test('lookup by exact title returns the page', async ({ apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, { title: 'Service Catalog', status: 'published' });
    const res = await apiAsAdmin.get('/api/v1/pages/by-title/Service%20Catalog');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.page.title).toBe('Service Catalog');
  });

  test('every save creates a page_versions row visible via /versions', async ({ apiAsAdmin }) => {
    const created = await createPageViaApi(apiAsAdmin, { title: 'Versioned', body: 'v1' });
    let token = created.version_token;
    for (let i = 2; i <= 4; i++) {
      const res = await apiAsAdmin.put(`/api/v1/pages/${created.id}`, {
        headers: { 'If-Match': String(token) },
        data: { body: `v${i}` },
      });
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      token = body.page.version_token;
    }
    const versions = await apiAsAdmin.get(`/api/v1/pages/${created.id}/versions`);
    const body = await versions.json();
    expect(body.versions.length).toBe(4);
  });

  test('soft delete + restore within 30 days', async ({ apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, { title: 'Recoverable' });
    const del = await apiAsAdmin.delete(`/api/v1/pages/${p.id}`);
    expect(del.status()).toBe(204);
    const list = await apiAsAdmin.get('/api/v1/pages');
    const body = await list.json();
    expect((body.items as { id: string }[]).find((x) => x.id === p.id)).toBeUndefined();
    const restore = await apiAsAdmin.post(`/api/v1/pages/${p.id}/restore`);
    expect(restore.ok()).toBeTruthy();
  });
});
