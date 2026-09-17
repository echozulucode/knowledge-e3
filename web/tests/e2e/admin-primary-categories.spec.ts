import type { Page } from '@playwright/test';
import { test, expect, createPageViaApi } from './fixtures.js';

/**
 * Admin → Primary categories (features/21-taxonomy-admin.feature;
 * the admin UX review §4.6).
 *
 * One DataTable: Name (slug muted) · Items (a link to search) · `⋯` (Rename…,
 * View items, Archive…). Create and Rename are EditDialogs; Archive confirms and
 * its toast offers Undo; Archived (`?view=archived`) lists retired terms with
 * Restore. Archive is disabled with "In use by N items" as text while items are
 * filed under the term.
 *
 * Every test names its own categories with a unique suffix; the DB is wiped per
 * run, not per test.
 */

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function uniqueSuffix(prefix: string, workerIndex: number): string {
  return `${prefix}-${workerIndex}-${Date.now()}`;
}

/** Create a category through the page's own dialog. */
async function createViaDialog(page: Page, name: string) {
  await page.getByRole('button', { name: 'New primary category' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New primary category' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/^Name/).fill(name);
  await dialog.getByRole('button', { name: 'Create category' }).click();
  await expect(dialog).toBeHidden();
}

async function openRowMenu(page: Page, name: string) {
  await page.getByRole('row', { name: new RegExp(name, 'i') }).getByRole('button', { name: `Actions for ${name}` }).click();
}

test.describe('admin primary category management', () => {
  test('creates and renames categories from dialogs, with the create action in the header', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const suffix = uniqueSuffix('admin-category', testInfo.workerIndex);
    const categoryName = `Field Notes ${suffix}`;
    const renamedName = `Customer Field Notes ${suffix}`;
    const slug = slugify(categoryName);
    const browseTitle = `Browse Category Rename Target ${suffix}`;

    await page.goto('/');
    // Admin left the sidebar for the user dropdown (admin-only), §3.4.
    await page.getByRole('button', { name: /user menu for admin/i }).click();
    await page.getByRole('button', { name: /^admin$/i }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Taxonomy', exact: true }).click();
    await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Categories' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Primary categories' })).toBeVisible();
    // The jargon and the filler are gone.
    await expect(page.getByText(/backend-supported|MVP path/i)).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: /metadata/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^refresh$/i })).toHaveCount(0);

    const table = page.getByRole('table', { name: 'Primary categories' });
    await expect(table).toBeVisible({ timeout: 15_000 });
    const headerButtonTop = await page.getByRole('button', { name: 'New primary category' }).first().evaluate((node) => node.getBoundingClientRect().top);
    const tableTop = await table.evaluate((node) => node.getBoundingClientRect().top);
    // Review §3.1: the create action is in the page header, above the catalog.
    expect(headerButtonTop).toBeLessThan(tableTop);

    // Create: Save stays disabled until there is a name; the slug preview follows the name.
    await page.getByRole('button', { name: 'New primary category' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New primary category' });
    await expect(dialog.getByRole('button', { name: 'Create category' })).toBeDisabled();
    await dialog.getByLabel(/^Name/).fill(categoryName);
    await expect(dialog.getByText(new RegExp(`Items file under the slug: ${slug}`))).toBeVisible();
    await dialog.getByRole('button', { name: 'Create category' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: `Created primary category “${categoryName}”` })).toBeVisible();

    const row = page.getByRole('row', { name: new RegExp(categoryName, 'i') });
    await expect(row).toContainText(slug);
    await expect(row).toContainText('0 items');

    // A duplicate is refused inside the dialog, next to the action.
    await page.getByRole('button', { name: 'New primary category' }).first().click();
    const duplicate = page.getByRole('dialog', { name: 'New primary category' });
    await duplicate.getByLabel(/^Name/).fill(categoryName);
    await duplicate.getByRole('button', { name: 'Create category' }).click();
    await expect(duplicate.getByRole('alert')).toContainText(/primary category slug already exists/i);
    await duplicate.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('dialog', { name: 'Discard changes?' }).getByRole('button', { name: 'Discard' }).click();

    // Items link to the search for the category.
    await createPageViaApi(apiAsAdmin, { title: browseTitle, body: 'Browse and search should use the latest category label.', status: 'draft', frontmatter: { categories: [slug] } });
    await page.reload();
    await expect(row).toContainText('1 item');
    await expect(row.getByRole('link', { name: '1 item' })).toHaveAttribute('href', new RegExp(`/search\\?category=${slug}`));

    // Rename from the row menu; the slug does not change.
    await openRowMenu(page, categoryName);
    await page.getByRole('menuitem', { name: 'Rename…' }).click();
    const rename = page.getByRole('dialog', { name: 'Rename primary category' });
    await expect(rename.getByLabel(/^Slug/)).toHaveCount(0);
    await rename.getByLabel(/^Name/).fill(renamedName);
    await rename.getByRole('button', { name: 'Save' }).click();
    await expect(rename).toBeHidden();
    const renamedRow = page.getByRole('row', { name: new RegExp(renamedName, 'i') });
    await expect(renamedRow).toContainText(slug);

    await page.goto(`/browse?q=${encodeURIComponent(renamedName)}`);
    await expect(page.locator('.PageList__CardTitle').filter({ hasText: browseTitle })).toBeVisible();
    await expect(page.getByText(new RegExp(`Category: ${renamedName}`, 'i'))).toBeVisible();
  });

  test('archive is blocked while in use, confirms otherwise, and Undo restores', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const suffix = uniqueSuffix('archive-category', testInfo.workerIndex);
    const inUseName = `In Use Category ${suffix}`;
    const unusedName = `Unused Category ${suffix}`;
    await apiAsAdmin.post('/api/v1/taxonomy/categories', { data: { name: inUseName } });
    await createPageViaApi(apiAsAdmin, { title: `In use ${suffix}`, body: 'Filed under the in-use category.', status: 'draft', frontmatter: { categories: [slugify(inUseName)] } });

    await page.goto('/admin/primary-categories');
    await expect(page.getByRole('table', { name: 'Primary categories' })).toBeVisible({ timeout: 15_000 });

    // In use: the menu item stays, disabled, with the reason as visible text.
    await openRowMenu(page, inUseName);
    const blocked = page.getByRole('menuitem', { name: 'Archive…' });
    await expect(blocked).toHaveAttribute('aria-disabled', 'true');
    await expect(blocked).toContainText('In use by 1 item');
    await blocked.click({ force: true });
    await expect(page.getByRole('dialog', { name: /^Archive/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Unused: confirm, then the toast's Undo brings it back.
    await createViaDialog(page, unusedName);
    await openRowMenu(page, unusedName);
    await page.getByRole('menuitem', { name: 'Archive…' }).click();
    const confirm = page.getByRole('dialog', { name: `Archive “${unusedName}”?` });
    await expect(confirm).toContainText('You can restore it from Archived.');
    await confirm.getByRole('button', { name: 'Archive category' }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByRole('row', { name: new RegExp(unusedName, 'i') })).toHaveCount(0);

    const toast = page.getByRole('status').filter({ hasText: `Archived “${unusedName}”` });
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('status').filter({ hasText: `Restored “${unusedName}”` })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(unusedName, 'i') })).toBeVisible();
  });

  test('the Archived view lists retired categories and restores them', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const suffix = uniqueSuffix('restore-category', testInfo.workerIndex);
    const name = `Retired Category ${suffix}`;
    const slug = slugify(name);
    await apiAsAdmin.post('/api/v1/taxonomy/categories', { data: { name } });
    const archived = await apiAsAdmin.delete(`/api/v1/taxonomy/categories/${slug}`);
    expect(archived.ok()).toBe(true);

    await page.goto('/admin/primary-categories');
    const views = page.getByRole('tablist', { name: 'Primary category views' });
    await views.getByRole('tab', { name: /^Archived/ }).click();
    await expect(page).toHaveURL(/[?&]view=archived/);
    await expect(views.getByRole('tab', { name: /^Archived/ })).toHaveAttribute('aria-selected', 'true');

    const table = page.getByRole('table', { name: 'Archived primary categories' });
    await expect(table).toBeVisible({ timeout: 15_000 });
    await openRowMenu(page, name);
    await page.getByRole('menuitem', { name: 'Restore' }).click();
    await expect(page.getByRole('status').filter({ hasText: `Restored “${name}”` })).toBeVisible();
    await expect(table.getByRole('row', { name: new RegExp(name, 'i') })).toHaveCount(0);

    // The view is in the URL: a reload keeps it, and Active has the term again.
    await page.reload();
    await expect(page.getByRole('table', { name: 'Archived primary categories' }).or(page.getByText('Nothing archived'))).toBeVisible({ timeout: 15_000 });
    await views.getByRole('tab', { name: /^Active/ }).click();
    await expect(page).not.toHaveURL(/view=archived/);
    await expect(page.getByRole('row', { name: new RegExp(name, 'i') })).toBeVisible();
  });

  test('keeps primary category management out of the article editor', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `category-route-target-${testInfo.workerIndex}-${Date.now()}`;
    const page = await createPageViaApi(apiAsAdmin, {
      title: `Dedicated Category Admin Route Target ${suffix}`,
      body: 'Article editor should remain focused on content editing.',
      status: 'draft',
      frontmatter: { categories: ['architecture'] },
    });

    await signedInPage.goto(`/p/${page.slug}/edit`);

    await expect(signedInPage.getByRole('link', { name: /primary categories/i })).toHaveCount(0);
    await expect(signedInPage.getByRole('combobox', { name: /primary category/i })).toHaveCount(0);
    await expect(signedInPage.getByRole('textbox', { name: /category/i })).toHaveCount(0);
  });
});
