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
    await signedInPage.goto('/');
    await signedInPage.getByRole('button', { name: /new item/i }).first().click();

    const dialog = signedInPage.getByRole('dialog', { name: /new item composer/i });
    await dialog.getByLabel(/^title/i).fill('Heading Scaffold Item');
    await dialog.getByRole('button', { name: /start draft/i }).click();

    await expect(signedInPage).toHaveURL((url) => url.pathname.startsWith('/items/') && Boolean(url.searchParams.get('edit')), {
      timeout: 10_000,
    });
    await expect(signedInPage.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Heading Scaffold Item', {
      timeout: 15_000,
    });
    await expect(markdownEditor(signedInPage)).toContainText('Overview');
    await expect(markdownEditor(signedInPage)).not.toContainText('Heading Scaffold Item');

    const created = await apiAsAdmin.get('/api/v1/pages/by-title/Heading%20Scaffold%20Item');
    expect(created.ok()).toBeTruthy();
    const body = await created.json();
    expect(body.page.body_markdown).toContain('## Overview');
    expect(body.page.body_markdown).not.toContain('# Heading Scaffold Item');
  });

  test('explains title metadata versus Markdown H1 content in edit mode', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Metadata Copy Item',
      body: '# Metadata Copy Item\n\nBody text.',
      status: 'draft',
    });

    await signedInPage.goto(`/p/${p.slug}?edit=1`);

    await expect(signedInPage.getByText(/Title is canonical item metadata/i)).toBeVisible();
    await expect(signedInPage.getByText(/Headings in the body are authored Markdown content/i)).toBeVisible();
  });

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
