import { test, expect, createPageViaApi } from './fixtures.js';

function markdownEditor(page: import('@playwright/test').Page) {
  return page.locator('.cm-content, .ProseMirror').first();
}

test.describe('item save validation and recovery', () => {
  test('duplicate title validation blocks save before PUT and preserves the unsaved draft', async ({ signedInPage, apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, { title: 'Existing Duplicate Title', body: 'Already here.', status: 'draft' });
    const draft = await createPageViaApi(apiAsAdmin, { title: 'Draft To Rename', body: 'Original draft body.', status: 'draft' });

    await signedInPage.goto(`/p/${draft.slug}?edit=1`);
    await signedInPage.getByRole('textbox', { name: 'Title', exact: true }).fill('Existing Duplicate Title');
    const editor = markdownEditor(signedInPage);
    await editor.click();
    await editor.press('Control+End');
    await editor.type(' Unsaved duplicate-title text.');

    let putAttempted = false;
    signedInPage.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes(`/api/v1/pages/${draft.id}`)) putAttempted = true;
    });

    await signedInPage.getByRole('region', { name: /item save status/i }).getByRole('button', { name: /^save/i }).click();

    const saveBar = signedInPage.getByRole('region', { name: /item save status/i });
    await expect(saveBar).toContainText(/already exists in this (space|topic)/i);
    await expect(signedInPage.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Existing Duplicate Title');
    await expect(editor).toContainText(/Unsaved duplicate-title text/i);
    expect(putAttempted).toBe(false);
  });

  // @quarantine (app bug): editor save/sync path hangs — pre-existing, predates the OKF pivot. Test is likely correct; fix the product.
  test('safe title sync updates the first H1 only when it still matches the previous title @quarantine', async ({ signedInPage, apiAsAdmin }) => {
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
    expect(syncedBody.page.body_markdown).toContain('# Synced New Title');

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

  // @quarantine (app bug): editor save/sync path hangs — pre-existing, predates the OKF pivot. Test is likely correct; fix the product.
  test('failed save shows actionable server validation and retry succeeds without losing Markdown edits @quarantine', async ({ signedInPage, apiAsAdmin }) => {
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
