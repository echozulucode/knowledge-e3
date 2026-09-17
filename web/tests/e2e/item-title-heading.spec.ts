import { test, expect, createPageViaApi } from './fixtures.js';

function markdownEditor(page: import('@playwright/test').Page) {
  return page.locator('.cm-content, .ProseMirror').first();
}

async function saveTitleChange(page: import('@playwright/test').Page, pageId: string, nextTitle: string) {
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill(nextTitle);
  const saveResponse = page.waitForResponse((response) =>
    response.request().method() === 'PUT' && response.url().includes(`/api/v1/pages/${pageId}`),
  );
  await page.getByRole('region', { name: /item save status/i }).getByRole('button', { name: /^save/i }).click();
  await saveResponse;
  await expect(page.getByRole('region', { name: /item save status/i })).toContainText(/saved/i, { timeout: 15_000 });
}

test.describe('item title and first-heading sync', () => {
  test('new item drafts keep title metadata out of the body scaffold', async ({ signedInPage, apiAsAdmin }) => {
    // Creation is a route now (plan §4.1): the content type's template seeds the
    // body, and the title stays metadata rather than becoming an H1 the author
    // then has to keep in sync by hand.
    await signedInPage.goto('/new?type=concept');
    await signedInPage.getByRole('textbox', { name: 'Title', exact: true }).fill('Heading Scaffold Item');

    const editor = markdownEditor(signedInPage);
    await expect(editor).toContainText('Overview', { timeout: 15_000 });
    await expect(editor).not.toContainText('Heading Scaffold Item');

    // Autosave (3 s after the last change) is what writes the draft.
    await editor.click();
    await editor.press('Control+End');
    await editor.type('\n\nFirst thoughts.');
    await expect(signedInPage).toHaveURL(/\/p\/heading-scaffold-item\/edit$/, { timeout: 20_000 });

    const created = await apiAsAdmin.get('/api/v1/pages/by-title/Heading%20Scaffold%20Item');
    expect(created.ok()).toBeTruthy();
    const body = await created.json();
    expect(body.page.body_markdown).toContain('## Overview');
    expect(body.page.body_markdown).not.toContain('# Heading Scaffold Item');
  });

  // De-quarantined 2026-09-11 (issue 92): passes against the current UI, verified over
  // three consecutive runs. It was swept up in the 2026-08-13 bulk quarantine, which
  // tagged 55 tests with one boilerplate 'not yet triaged' comment.
  test('preserves an imported first H1 even when it matches the old metadata title', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Synced Heading Before',
      body: '# Synced Heading Before\n\nBody text.',
      status: 'draft',
    });

    await signedInPage.goto(`/p/${p.slug}?edit=1`);
    await saveTitleChange(signedInPage, p.id, 'Synced Heading After');

    const updated = await apiAsAdmin.get('/api/v1/pages/by-title/Synced%20Heading%20After');
    expect(updated.ok()).toBeTruthy();
    const body = await updated.json();
    expect(body.page.body_markdown).toContain('# Synced Heading Before\n\nBody text.');
    expect(body.page.body_markdown).not.toContain('# Synced Heading After');
  });

  // De-quarantined 2026-09-11 (issue 92): passes against the current UI, verified over
  // three consecutive runs. It was swept up in the 2026-08-13 bulk quarantine, which
  // tagged 55 tests with one boilerplate 'not yet triaged' comment.
  test('does not rewrite a manually authored first H1 when title metadata changes', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Metadata Title Before',
      body: '# Handwritten Markdown Heading\n\nBody text.',
      status: 'draft',
    });

    await signedInPage.goto(`/p/${p.slug}?edit=1`);
    await saveTitleChange(signedInPage, p.id, 'Metadata Title After');

    const updated = await apiAsAdmin.get('/api/v1/pages/by-title/Metadata%20Title%20After');
    expect(updated.ok()).toBeTruthy();
    const body = await updated.json();
    expect(body.page.body_markdown).toContain('# Handwritten Markdown Heading\n\nBody text.');
    expect(body.page.body_markdown).not.toContain('# Metadata Title After');
  });
});
