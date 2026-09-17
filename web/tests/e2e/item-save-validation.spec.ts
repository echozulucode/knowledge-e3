import { test, expect, createPageViaApi } from './fixtures.js';

function markdownEditor(page: import('@playwright/test').Page) {
  return page.locator('.cm-content, .ProseMirror').first();
}

test.describe('item save validation and recovery', () => {
  /**
   * The duplicate-title 409, on its new surface.
   *
   * PageView's edit shell refused this before the PUT was made. Compose lets the
   * server answer and classifies the reply (`saveOutcome` in
   * features/compose/saveErrors.ts): a bare 409 saying "already exists" is a
   * title collision, NOT an optimistic-concurrency conflict, so it must not
   * raise the ConflictDialog — there is nothing to diff. What the author gets is
   * the server's own sentence plus the instruction, and their draft untouched.
   */
  test('a duplicate title is refused with an instruction and the unsaved draft survives', async ({ signedInPage, apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, { title: 'Existing Duplicate Title', body: 'Already here.', status: 'draft' });
    const draft = await createPageViaApi(apiAsAdmin, { title: 'Draft To Rename', body: 'Original draft body.', status: 'draft' });

    await signedInPage.goto(`/p/${draft.slug}/edit`);
    const titleInput = signedInPage.getByRole('textbox', { name: 'Title', exact: true });
    await expect(titleInput).toHaveValue('Draft To Rename', { timeout: 15_000 });
    await titleInput.fill('Existing Duplicate Title');
    const editor = markdownEditor(signedInPage);
    await editor.click();
    await editor.press('Control+End');
    await editor.type(' Unsaved duplicate-title text.');

    const saveBar = signedInPage.getByRole('region', { name: /item save status/i });
    await saveBar.getByRole('button', { name: /save draft/i }).click();

    await expect(saveBar).toContainText(/already exists in this (space|topic)/i, { timeout: 15_000 });
    await expect(saveBar).toContainText(/choose a unique title before saving/i);
    // Not a version conflict: the diff dialog would be the wrong instrument.
    await expect(signedInPage.getByRole('heading', { name: /edit conflict/i })).toHaveCount(0);

    // Nothing the author typed is lost.
    await expect(titleInput).toHaveValue('Existing Duplicate Title');
    await expect(editor).toContainText(/Unsaved duplicate-title text/i);

    // And nothing was written.
    const after = await apiAsAdmin.get(`/api/v1/pages/${draft.id}`);
    expect(after.ok()).toBeTruthy();
    const saved = (await after.json()).page;
    expect(saved.title).toBe('Draft To Rename');
    expect(saved.body_markdown).not.toContain('Unsaved duplicate-title text');
  });

  test('renaming the metadata title preserves the authored first H1 (matching or not)', async ({ signedInPage, apiAsAdmin }) => {
    const synced = await createPageViaApi(apiAsAdmin, {
      title: 'Sync Source Title',
      body: '# Sync Source Title\n\nBody that should keep its heading aligned.',
      status: 'draft',
    });
    const independent = await createPageViaApi(apiAsAdmin, {
      title: 'Independent Source Title',
      body: '# Hand-Written Heading\n\nBody that should keep its custom heading.',
      status: 'draft',
    });

    await signedInPage.goto(`/p/${synced.slug}?edit=1`);
    await signedInPage.getByRole('textbox', { name: 'Title', exact: true }).fill('Synced New Title');
    await expect(signedInPage.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Synced New Title');
    await signedInPage.getByRole('region', { name: /item save status/i }).getByRole('button', { name: /^save/i }).click();
    await expect(signedInPage.getByRole('region', { name: /item save status/i }).getByText(/^Saved/)).toBeVisible({ timeout: 15_000 });
    const syncedResponse = await apiAsAdmin.get(`/api/v1/pages/${synced.id}`);
    const syncedBody = await syncedResponse.json();
    // Policy (titleHeadingSync.ts + its unit test): renaming the metadata title
    // updates the title but PRESERVES the authored first H1 as body content — even
    // when the heading matched the old title. The H1 is not rewritten.
    expect(syncedBody.page.title).toBe('Synced New Title');
    expect(syncedBody.page.body_markdown).toContain('# Sync Source Title');
    expect(syncedBody.page.body_markdown).not.toContain('# Synced New Title');

    await signedInPage.goto(`/p/${independent.slug}?edit=1`);
    await signedInPage.getByRole('textbox', { name: 'Title', exact: true }).fill('Independent New Title');
    await expect(signedInPage.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Independent New Title');
    await signedInPage.getByRole('region', { name: /item save status/i }).getByRole('button', { name: /^save/i }).click();
    await expect(signedInPage.getByRole('region', { name: /item save status/i }).getByText(/^Saved/)).toBeVisible({ timeout: 15_000 });
    const independentResponse = await apiAsAdmin.get(`/api/v1/pages/${independent.id}`);
    const independentBody = await independentResponse.json();
    expect(independentBody.page.body_markdown).toContain('# Hand-Written Heading');
    expect(independentBody.page.body_markdown).not.toContain('# Independent New Title');
  });

  test('failed save shows actionable server validation and retry succeeds without losing Markdown edits', async ({ signedInPage, apiAsAdmin }) => {
    const draft = await createPageViaApi(apiAsAdmin, { title: 'Retry Validation Draft', body: 'Original retry body.', status: 'draft' });

    await signedInPage.goto(`/p/${draft.slug}?edit=1`);
    const editor = markdownEditor(signedInPage);
    await editor.click();
    await editor.press('Control+End');
    await editor.type('\n\nRetry should keep this unsaved Markdown.');

    let failedOnce = false;
    await signedInPage.route(`**/api/v1/pages/${draft.id}`, async (route, request) => {
      if (request.method() === 'PUT' && !failedOnce) {
        failedOnce = true;
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'invalid taxonomy: categories must be a list of strings' }),
        });
        return;
      }
      await route.continue();
    });

    const saveBar = signedInPage.getByRole('region', { name: /item save status/i });
    await saveBar.getByRole('button', { name: /^save/i }).click();
    await expect(saveBar).toContainText(/invalid taxonomy: categories must be a list of strings/i);
    await expect(editor).toContainText(/Retry should keep this unsaved Markdown/i);

    await saveBar.getByRole('button', { name: /^save/i }).click();
    await expect(saveBar.getByText(/^Saved/)).toBeVisible({ timeout: 15_000 });

    const response = await apiAsAdmin.get(`/api/v1/pages/${draft.id}`);
    const body = await response.json();
    expect(body.page.body_markdown).toContain('Retry should keep this unsaved Markdown');
  });

  test('version conflicts are rendered clearly in the editor shell while preserving edits', async ({ signedInPage, apiAsAdmin }) => {
    const draft = await createPageViaApi(apiAsAdmin, { title: 'Conflict Validation Draft', body: 'Original conflict body.', status: 'draft' });
    await signedInPage.goto(`/p/${draft.slug}?edit=1`);
    const editor = markdownEditor(signedInPage);
    await editor.click();
    await editor.press('Control+End');
    await editor.type(' Local conflict text.');

    const bump = await apiAsAdmin.put(`/api/v1/pages/${draft.id}`, {
      headers: { 'If-Match': String(draft.version_token) },
      data: { body: 'Server-side concurrent update.' },
    });
    expect(bump.ok()).toBeTruthy();

    const saveBar = signedInPage.getByRole('region', { name: /item save status/i });
    await saveBar.getByRole('button', { name: /^save/i }).click();
    await expect(saveBar).toContainText(/version conflict|conflict detected|conflict needs attention/i, { timeout: 10_000 });
    await expect(signedInPage.getByRole('heading', { name: /edit conflict/i })).toBeVisible({ timeout: 10_000 });
    await expect(editor).toContainText(/Local conflict text/i);
  });
});
