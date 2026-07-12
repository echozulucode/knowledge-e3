import { test, expect } from './fixtures.js';

test.describe('new item composer', () => {
  test('creates a focused draft from a polished in-app composer with metadata', async ({ signedInPage, apiAsAdmin }) => {
    signedInPage.on('dialog', (dialog) => {
      throw new Error(`New item flow must not open browser dialogs; saw ${dialog.type()} ${dialog.message()}`);
    });

    await signedInPage.goto('/?view=all&q=composer-tag');
    await signedInPage.getByRole('button', { name: /new item/i }).first().click();

    const dialog = signedInPage.getByRole('dialog', { name: /new item composer/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('#composer-tag')).toBeVisible();

    await dialog.getByLabel(/^title/i).fill('Composer Created Item');
    await dialog.getByRole('combobox', { name: /^topic$/i }).selectOption('Product workspace');
    await expect(dialog.getByLabel(/new category name/i)).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);
    await dialog.getByRole('combobox', { name: /primary category/i }).selectOption('Research notes');
    await dialog.getByLabel(/tags/i).fill('adhoc tag');
    await dialog.getByLabel(/tags/i).press('Enter');
    await expect(dialog.getByText('#adhoc-tag')).toBeVisible();
    await dialog.getByLabel(/groups/i).fill('Editor UX, Data Entry');
    await dialog.getByLabel(/summary/i).fill('Composer captured metadata before the editor opened.');
    await dialog.getByLabel(/body notes/i).fill('Capture acceptance criteria and first thoughts here.');
    await dialog.getByRole('button', { name: /start draft/i }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    await expect(signedInPage).toHaveURL((url) => url.pathname.startsWith('/items/') && Boolean(url.searchParams.get('edit')), {
      timeout: 10_000,
    });
    await expect(signedInPage.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Composer Created Item', { timeout: 15_000 });
    const editor = signedInPage.locator('.cm-content, .ProseMirror').first();
    await expect(editor).toContainText('Capture acceptance criteria and first thoughts here.');

    const created = await apiAsAdmin.get('/api/v1/pages/by-title/Composer%20Created%20Item');
    expect(created.ok()).toBeTruthy();
    const body = await created.json();
    expect(body.page.status).toBe('draft');
    expect(body.page.tags).toContain('composer-tag');
    expect(body.page.tags).toContain('adhoc-tag');
    expect(body.page.categories).toContain('research-notes');
    expect(body.page.groups).toContain('editor-ux');
    expect(body.page.groups).toContain('data-entry');
    expect(body.page.frontmatter.summary).toBe('Composer captured metadata before the editor opened.');
    expect(body.page.frontmatter.topic).toBe('Product workspace');

    await signedInPage.goto('/');
    await expect(signedInPage.locator('.PageList__Card').filter({ has: signedInPage.locator('.PageList__CardTitle', { hasText: 'Composer Created Item' }) })).toBeVisible({ timeout: 15_000 });
    await signedInPage.goto('/?view=all&q=composer-tag');
    await expect(signedInPage.locator('.PageList__Card').filter({ has: signedInPage.locator('.PageList__CardTitle', { hasText: 'Composer Created Item' }) })).toBeVisible({ timeout: 15_000 });
  });

  test('cancelling the composer is explicit and does not create an untitled item', async ({ signedInPage, apiAsAdmin }) => {
    await signedInPage.goto('/');
    await signedInPage.getByRole('button', { name: /new item/i }).first().click();
    const dialog = signedInPage.getByRole('dialog', { name: /new item composer/i });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/^title/i).fill('Throwaway Composer Draft');
    await dialog.getByRole('button', { name: /discard/i }).click();
    await expect(dialog).toBeHidden();

    const pages = await apiAsAdmin.get('/api/v1/pages');
    expect(pages.ok()).toBeTruthy();
    const body = await pages.json();
    const titles = (body.items as { title: string }[]).map((item) => item.title);
    expect(titles).not.toContain('Throwaway Composer Draft');
    expect(titles).not.toContain('Untitled');
  });

  test('surfaces create failures inside the composer instead of failing silently', async ({ signedInPage }) => {
    await signedInPage.route('**/api/v1/pages', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Create failed in test' }),
        });
        return;
      }
      await route.continue();
    });

    await signedInPage.goto('/');
    await signedInPage.getByRole('button', { name: /new item/i }).first().click();

    const dialog = signedInPage.getByRole('dialog', { name: /new item composer/i });
    await dialog.getByLabel(/^title/i).fill('Composer Failure Item');
    await dialog.getByRole('button', { name: /start draft/i }).click();

    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toContainText('Create failed in test');
    await expect(signedInPage).toHaveURL((url) => url.pathname === '/');
  });

  test('manages category choices from settings instead of the composer', async ({ signedInPage }) => {
    await signedInPage.goto('/?view=settings');
    await signedInPage.getByLabel(/new category name/i).fill('Personal Notes');
    await signedInPage.getByRole('button', { name: /add category/i }).click();
    await expect(signedInPage.getByLabel(/category choices/i).getByText('Personal Notes')).toBeVisible();

    await signedInPage.getByRole('button', { name: /new item/i }).first().click();
    const dialog = signedInPage.getByRole('dialog', { name: /new item composer/i });

    await expect(dialog.getByLabel(/new category name/i)).toHaveCount(0);
    await dialog.getByRole('combobox', { name: /primary category/i }).selectOption('Personal Notes');
    await expect(dialog.getByRole('combobox', { name: /primary category/i })).toHaveValue('Personal Notes');
  });
});
