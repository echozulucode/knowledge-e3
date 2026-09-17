import { test, expect, createPageViaApi } from './fixtures.js';

/**
 * Maps to features/09-compose.feature.
 *
 * Selectors the Compose surface exposes:
 *   - textbox "Title" (#compose-title-input)
 *   - editor: .cm-content / .ProseMirror
 *   - region "Item save status" with buttons "Save draft", "Preview", "Publish…"
 *   - dialog "Publish" with labelled controls: Topic, Section, Content type,
 *     Primary category, Tags, Groups, Description, Authors, Series,
 *     Series position, Published at, Cover, Status, Review by,
 *     checkbox "I reviewed this content", buttons "Save changes" / "Publish"
 *   - dialog "Preview"
 */

function markdownEditor(page: import('@playwright/test').Page) {
  return page.locator('.cm-content, .me-wysiwyg-input, .ProseMirror').first();
}

function saveStatus(page: import('@playwright/test').Page) {
  return page.getByRole('region', { name: /item save status/i });
}

function publishDrawer(page: import('@playwright/test').Page) {
  return page.getByRole('dialog', { name: /^publish$/i });
}

/**
 * Seed a curated primary category and return its SLUG — which is what the picker
 * writes and what the publish gate lints against (primary categories are
 * curated, not emergent). Seeding the display name instead produces an item the
 * gate then refuses, which looks like a UI bug and is not one.
 */
async function ensureCategory(api: import('@playwright/test').APIRequestContext, name: string): Promise<string> {
  const res = await api.post('/api/v1/taxonomy/categories', { data: { name } });
  if (!res.ok() && res.status() !== 409) {
    throw new Error(`seed category failed: ${res.status()} ${await res.text()}`);
  }
  if (res.ok()) {
    const slug = (await res.json())?.category?.slug;
    if (typeof slug === 'string' && slug) return slug;
  }
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

test.describe('compose surface', () => {
  test('creates a blog post from /new through the publish drawer', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const title = `Compose Blog Post ${suffix}`;
    const category = await ensureCategory(apiAsAdmin, 'How-to');

    await signedInPage.goto('/new?type=blog-post');

    const titleInput = signedInPage.getByRole('textbox', { name: 'Title', exact: true });
    await expect(titleInput).toBeVisible();
    // Blog Post template pre-fills the empty body.
    await expect(markdownEditor(signedInPage)).toContainText('Introduction', { timeout: 15_000 });

    await titleInput.fill(title);
    await saveStatus(signedInPage).getByRole('button', { name: /publish/i }).click();

    const drawer = publishDrawer(signedInPage);
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel('Content type')).toHaveValue('blog-post');
    await drawer.getByLabel('Primary category').selectOption(category);
    await drawer.getByLabel('Description').fill('A short excerpt for the feed.');
    await drawer.getByLabel('Authors').fill('Ada Lovelace');
    await drawer.getByLabel('Authors').press('Enter');
    await drawer.getByLabel('Published at').fill('2026-09-06');

    const publish = drawer.getByRole('button', { name: /^publish$/i });
    await expect(publish).toBeEnabled();
    await publish.click();

    await expect(drawer).toBeHidden({ timeout: 15_000 });
    await expect(signedInPage).toHaveURL((url) => /^\/p\/[^/]+$/.test(url.pathname), { timeout: 15_000 });
    await expect(signedInPage.getByRole('heading', { level: 1, name: title })).toBeVisible({ timeout: 15_000 });

    const created = await apiAsAdmin.get(`/api/v1/pages/by-title/${encodeURIComponent(title)}`);
    expect(created.ok()).toBeTruthy();
    const body = await created.json();
    expect(body.page.status).toBe('published');
    expect(body.page.frontmatter.type).toBe('Blog Post');
    expect(body.page.frontmatter.description).toBe('A short excerpt for the feed.');
    expect(body.page.frontmatter.authors).toEqual(['Ada Lovelace']);
    // The picker writes the SLUG: primary categories are curated, and the slug is
    // what the publish gate lints against.
    expect(body.page.frontmatter.categories).toEqual([category]);
    expect(String(body.page.frontmatter.published_at)).toContain('2026-09-06');
    expect(body.page.body_markdown).toContain('## Introduction');
  });

  test('autosave creates the draft and reports Saved', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const title = `Autosaved Draft ${testInfo.workerIndex}-${Date.now()}`;
    await signedInPage.goto('/new');

    // Register before typing: the debounce fires 3 s after the last change.
    const createRequest = signedInPage.waitForRequest(
      (req) => req.method() === 'POST' && /\/api\/v1\/pages$/.test(req.url()),
      { timeout: 20_000 },
    );
    await signedInPage.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
    const editor = markdownEditor(signedInPage);
    await editor.click();
    await editor.type('Autosave should persist this line.');
    await createRequest;
    await expect(saveStatus(signedInPage)).toContainText(/saved/i, { timeout: 15_000 });
    await expect(signedInPage).toHaveURL(/\/p\/[^/]+\/edit$/, { timeout: 15_000 });

    const created = await apiAsAdmin.get(`/api/v1/pages/by-title/${encodeURIComponent(title)}`);
    expect(created.ok()).toBeTruthy();
    const body = await created.json();
    expect(body.page.status).toBe('draft');
    expect(body.page.body_markdown).toContain('Autosave should persist this line.');
  });

  test('publish requires exactly one primary category', async ({ signedInPage }, testInfo) => {
    await signedInPage.goto('/new?type=concept');
    await signedInPage.getByRole('textbox', { name: 'Title', exact: true }).fill(`Needs Category ${testInfo.workerIndex}-${Date.now()}`);
    await saveStatus(signedInPage).getByRole('button', { name: /publish/i }).click();

    const drawer = publishDrawer(signedInPage);
    await expect(drawer).toBeVisible();
    await drawer.getByLabel('Description').fill('Has a description but no category yet.');

    const publish = drawer.getByRole('button', { name: /^publish$/i });
    await expect(publish).toBeDisabled();
    await expect(drawer.getByText(/choose exactly one primary category/i).first()).toBeVisible();

    const categorySelect = drawer.getByLabel('Primary category');
    const firstCategory = await categorySelect.locator('option').nth(1).getAttribute('value');
    expect(firstCategory).toBeTruthy();
    await categorySelect.selectOption(firstCategory!);
    await expect(publish).toBeEnabled();
  });

  test('the reviewed checkbox appends a human verified entry on publish', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const category = await ensureCategory(apiAsAdmin, 'Reference');
    const p = await createPageViaApi(apiAsAdmin, {
      title: `Reviewed On Publish ${testInfo.workerIndex}-${Date.now()}`,
      body: '## Overview\n\nReady to be reviewed.',
      status: 'draft',
      frontmatter: { type: 'Concept', categories: [category], description: 'Reviewed before publishing.' },
    });

    await signedInPage.goto(`/p/${p.slug}/edit`);
    await expect(signedInPage.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(/Reviewed On Publish/, { timeout: 15_000 });
    await saveStatus(signedInPage).getByRole('button', { name: /publish/i }).click();

    const drawer = publishDrawer(signedInPage);
    await drawer.getByRole('checkbox', { name: /i reviewed this content/i }).check();
    const publish = drawer.getByRole('button', { name: /^publish$/i });
    await expect(publish).toBeEnabled();
    await publish.click();
    await expect(drawer).toBeHidden({ timeout: 15_000 });

    const saved = await apiAsAdmin.get(`/api/v1/pages/${p.id}`);
    expect(saved.ok()).toBeTruthy();
    const body = await saved.json();
    expect(body.page.status).toBe('published');
    const verified = body.page.frontmatter.verified as Array<{ by: string; at: string }>;
    expect(Array.isArray(verified)).toBeTruthy();
    expect(verified.some((entry) => entry.by === 'human:admin' && typeof entry.at === 'string')).toBeTruthy();

    // The read page now states the human-reviewed tier in its byline — quiet
    // text with an icon rather than a chip (home plan R2.4), but always there.
    await signedInPage.goto(`/p/${p.slug}`);
    await expect(signedInPage.locator('.kp-trust-inline__label').first()).toContainText(/human-reviewed/i, { timeout: 15_000 });
  });

  test('Edit on the read page opens the compose route for the item', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const title = `Compose Edit Route ${testInfo.workerIndex}-${Date.now()}`;
    const p = await createPageViaApi(apiAsAdmin, {
      title,
      body: 'Existing body for the compose route.',
      status: 'draft',
    });

    await signedInPage.goto(`/p/${p.slug}`);
    await expect(signedInPage.locator('.kp-trust-inline__label').first()).toContainText(/unverified/i, { timeout: 15_000 });
    await signedInPage.getByRole('button', { name: /edit page/i }).click();

    await expect(signedInPage).toHaveURL(new RegExp(`/p/${p.slug}/edit$`), { timeout: 15_000 });
    await expect(signedInPage.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(title, { timeout: 15_000 });
    await expect(markdownEditor(signedInPage)).toContainText('Existing body for the compose route.');
    await expect(saveStatus(signedInPage).getByRole('button', { name: /save draft/i })).toBeVisible();

    // Preview renders the real read view for the draft body.
    await saveStatus(signedInPage).getByRole('button', { name: /preview/i }).click();
    const preview = signedInPage.getByRole('dialog', { name: /^preview$/i });
    await expect(preview).toBeVisible();
    await expect(preview.locator('.kp-read-view')).toContainText('Existing body for the compose route.');
    await signedInPage.keyboard.press('Escape');
    await expect(preview).toBeHidden();
  });

  /**
   * The publish-time refusal, staged at the boundary Compose consumes.
   *
   * The 422 is produced by the server's publish gate (`assertPublishable` in
   * content-commands.service.ts) and is exercised there and in the MCP tools.
   * What is untested is the half an author actually meets: whether Compose puts
   * the diagnostics on screen, keeps the item unsaved, and offers the way back.
   * Reaching that through a real refusal would need a document the drawer
   * accepts and the server rejects, which is a moving target and would make this
   * test about the gap between two validators rather than about the rendering.
   * So the response is staged, exactly as external-source.spec.ts stages
   * `changed_on_disk`.
   */
  test('a publish the server refuses renders the diagnostics and leaves the item a draft', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const category = await ensureCategory(apiAsAdmin, 'Reference');
    const p = await createPageViaApi(apiAsAdmin, {
      title: `Refused Publish ${suffix}`,
      body: 'Body of an item the publish gate will not accept.',
      status: 'draft',
      frontmatter: { type: 'concept', description: 'Has everything the drawer asks for.', categories: [category] },
    });

    await signedInPage.route(`**/api/v1/pages/${p.id}`, async (route, request) => {
      if (request.method() !== 'PUT') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          message: 'This item cannot be published until 2 content-model error(s) are fixed',
          reason: 'lint_failed',
          diagnostics: [
            { code: 'category.unknown', severity: 'error', message: 'Unknown category "Ghost Category"', path: 'categories' },
            { code: 'description.missing', severity: 'error', message: 'A description is required to publish', path: 'description' },
          ],
        }),
      });
    });

    await signedInPage.goto(`/p/${p.slug}/edit`);
    await expect(signedInPage.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(/Refused Publish/, {
      timeout: 15_000,
    });
    await saveStatus(signedInPage).getByRole('button', { name: /publish/i }).click();

    const drawer = publishDrawer(signedInPage);
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: /^publish$/i }).click();

    // The drawer stays open on a refused save, holding its own values, so the
    // author does not have to re-enter them.
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: /close publish drawer/i }).click();
    await expect(drawer).toBeHidden();

    const refusal = signedInPage.getByRole('alert').filter({ hasText: 'Cannot publish yet' });
    await expect(refusal).toBeVisible({ timeout: 15_000 });
    await expect(refusal).toContainText('2 content-model error(s)');
    // Each diagnostic names the drawer control to fix, not the raw frontmatter
    // key an author may never have seen (drawerFieldLabel in saveErrors.ts).
    await expect(refusal.locator('code', { hasText: 'Primary category' })).toBeVisible();
    await expect(refusal.locator('code', { hasText: 'Description' })).toBeVisible();
    await expect(refusal).toContainText('Unknown category "Ghost Category"');
    await expect(refusal).toContainText(/the item is unchanged — nothing was saved/i);

    // Nothing was written: it is still the draft it was.
    const after = await apiAsAdmin.get(`/api/v1/pages/${p.id}`);
    expect(after.ok()).toBeTruthy();
    expect((await after.json()).page.status).toBe('draft');

    // And the refusal offers the way back to fixing it.
    await refusal.getByRole('button', { name: /open publish drawer/i }).click();
    await expect(drawer).toBeVisible();
  });

  /**
   * Ported from item-editor.spec.ts (deleted 2026-09-11): PageView's inline
   * edit shell is gone, but "a save failure is stated next to the Save action"
   * is a promise Compose still makes, and it is the only place the footer's
   * error line is exercised.
   */
  test('a save failure is stated next to the Save action', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: `Visible Save Error ${testInfo.workerIndex}-${Date.now()}`,
      body: 'A save validation error should be near the action.',
      status: 'draft',
    });

    await signedInPage.goto(`/p/${p.slug}/edit`);
    const title = signedInPage.getByRole('textbox', { name: 'Title', exact: true });
    await expect(title).toHaveValue(/Visible Save Error/, { timeout: 15_000 });
    await title.fill('');
    await saveStatus(signedInPage).getByRole('button', { name: /save draft/i }).click();

    await expect(saveStatus(signedInPage)).toContainText(/title is required/i);
  });

  /**
   * Ported from item-editor.spec.ts: Ctrl+S from inside the writing area saves
   * without moving the caret. Compose handles it at the WINDOW (see the keydown
   * effect in Compose.tsx), which is what makes the next test possible too.
   */
  test('Ctrl+S saves from the writing area and keeps the caret where it was', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: `Keyboard Save ${testInfo.workerIndex}-${Date.now()}`,
      body: 'Before keyboard save.',
      status: 'draft',
    });

    await signedInPage.goto(`/p/${p.slug}/edit`);
    const editor = markdownEditor(signedInPage);
    await expect(editor).toContainText('Before keyboard save.', { timeout: 15_000 });
    await editor.click();
    await editor.press('Control+End');
    await editor.type(' Saved without leaving focus.');

    const putRequest = signedInPage.waitForRequest(
      (req) => req.method() === 'PUT' && req.url().includes(`/api/v1/pages/${p.id}`),
      { timeout: 20_000 },
    );
    await editor.press('Control+S');
    await putRequest;

    await expect(saveStatus(signedInPage)).toContainText(/^Saved/, { timeout: 15_000 });
    await expect(editor).toBeFocused();
  });

  /**
   * The other half of that keydown effect, and the reason it lives on the window
   * rather than on the editor: the title field, the cover picker and the drawer
   * all sit OUTSIDE the writing area, and an author who has just retitled an
   * item should not have to click back into the body to save it.
   */
  test('Cmd+S saves from the title field and Esc leaves for the read page', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const p = await createPageViaApi(apiAsAdmin, {
      title: `Window Shortcuts ${suffix}`,
      body: 'Body that the shortcuts never touch.',
      status: 'draft',
    });
    const renamed = `Window Shortcuts Renamed ${suffix}`;

    await signedInPage.goto(`/p/${p.slug}/edit`);
    const title = signedInPage.getByRole('textbox', { name: 'Title', exact: true });
    await expect(title).toHaveValue(/Window Shortcuts/, { timeout: 15_000 });

    await title.click();
    await title.fill(renamed);
    await expect(saveStatus(signedInPage)).toContainText(/unsaved changes/i);

    const putRequest = signedInPage.waitForRequest(
      (req) => req.method() === 'PUT' && req.url().includes(`/api/v1/pages/${p.id}`),
      { timeout: 20_000 },
    );
    await title.press('Control+S');
    await putRequest;
    await expect(saveStatus(signedInPage)).toContainText(/^Saved/, { timeout: 15_000 });

    const saved = await apiAsAdmin.get(`/api/v1/pages/${p.id}`);
    expect((await saved.json()).page.title).toBe(renamed);

    // Esc from outside a form control leaves Compose. Every layer above the
    // editor owns Esc for itself, so it is only offered when none of them is
    // open; nothing is unsaved here, so no confirm() can appear either.
    signedInPage.on('dialog', (dialog) => {
      throw new Error(`Esc on a clean document must not confirm; saw ${dialog.type()} ${dialog.message()}`);
    });
    await signedInPage.locator('.kp-compose-crumbs').click();
    await signedInPage.keyboard.press('Escape');
    await expect(signedInPage).toHaveURL((url) => url.pathname === `/p/${p.slug}`, { timeout: 15_000 });
  });

  /**
   * Ported from taxonomy-dropdown-consistency.spec.ts (deleted 2026-09-11). The
   * modal composer it tested is gone; the Publish drawer is where an author now
   * meets the taxonomy, and the promise is the same one — the dropdowns show the
   * catalog, not a hand-maintained copy of it.
   */
  test('the publish drawer offers the authoritative topic and category catalogs', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    // `?curated=1` is "what may I publish into" — the admin-curated catalog,
    // which is what the picker offers. The unfiltered list is "what exists", and
    // includes emergent terms an author must not be able to pick.
    const [topicsResponse, categoriesResponse] = await Promise.all([
      apiAsAdmin.get('/api/v1/topics'),
      apiAsAdmin.get('/api/v1/taxonomy/categories?curated=1'),
    ]);
    expect(topicsResponse.ok()).toBeTruthy();
    expect(categoriesResponse.ok()).toBeTruthy();
    const sorted = (values: string[]) => [...values].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const actualTopics = sorted(((await topicsResponse.json()).topics as { name: string }[]).map((t) => t.name));
    const actualCategories = sorted(((await categoriesResponse.json()).categories as { name: string }[]).map((c) => c.name));

    await signedInPage.goto('/new?type=concept');
    await signedInPage.getByRole('textbox', { name: 'Title', exact: true }).fill(`Drawer Catalog ${testInfo.workerIndex}-${Date.now()}`);
    await saveStatus(signedInPage).getByRole('button', { name: /publish/i }).click();

    const drawer = publishDrawer(signedInPage);
    await expect(drawer).toBeVisible();

    const optionLabels = (locator: import('@playwright/test').Locator) =>
      locator.locator('option').evaluateAll((options) => options.map((o) => o.textContent?.trim() ?? '').filter(Boolean));

    const drawerTopics = (await optionLabels(drawer.getByLabel('Topic'))).filter((label) => label !== 'No topic');
    const drawerCategories = (await optionLabels(drawer.getByLabel('Primary category'))).filter(
      (label) => label !== 'Choose category…',
    );
    expect(sorted(drawerTopics)).toEqual(actualTopics);
    expect(sorted(drawerCategories)).toEqual(actualCategories);
  });
});

/**
 * The two deep links that used to open an editor somewhere else. Both forward
 * to Compose now rather than dead-ending, which matters because they are in
 * bookmarks, in older items' links, and in the sidebar's own New item button.
 */
test.describe('the doors into Compose', () => {
  test('the legacy ?edit=1 deep link forwards to the compose route', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: `Legacy Edit Link ${testInfo.workerIndex}-${Date.now()}`,
      body: 'Opened through the old inline-editor link.',
      status: 'draft',
    });

    await signedInPage.goto('/');
    await signedInPage.goto(`/p/${p.slug}?edit=1`);

    await expect(signedInPage).toHaveURL(new RegExp(`/p/${p.slug}/edit$`), { timeout: 15_000 });
    await expect(signedInPage.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(/Legacy Edit Link/, {
      timeout: 15_000,
    });

    // The forward REPLACES, so Back goes where the author came from rather than
    // bouncing through the redirect forever.
    await signedInPage.goBack();
    await expect(signedInPage).toHaveURL((url) => url.pathname === '/');
  });

  test('the legacy /browse?new=<type> handoff forwards to /new', async ({ signedInPage }) => {
    await signedInPage.goto('/browse?new=faq');

    await expect(signedInPage).toHaveURL((url) => url.pathname === '/new' && url.searchParams.get('type') === 'faq', {
      timeout: 15_000,
    });
    await expect(signedInPage.getByRole('textbox', { name: 'Title', exact: true })).toBeVisible({ timeout: 15_000 });

    // The sidebar's own New item button is one of the callers.
    await signedInPage.goto('/browse');
    await signedInPage.locator('.kp-sidebar').getByRole('button', { name: 'Create a new item' }).click();
    await expect(signedInPage).toHaveURL((url) => url.pathname === '/new', { timeout: 15_000 });
  });
});
