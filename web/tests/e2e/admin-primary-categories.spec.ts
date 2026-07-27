import { test, expect, createPageViaApi } from './fixtures.js';

test.describe('admin primary category management', () => {
  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('creates primary categories from Admin and reports duplicate validation errors @quarantine', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `admin-category-${testInfo.workerIndex}-${Date.now()}`;
    const architectureTitle = `Admin Category Seed Architecture ${suffix}`;
    const fieldResearchTitle = `Admin Category Seed Field Research ${suffix}`;
    const fieldResearchSlug = `field-research-${suffix}`;
    const categoryName = `Field Notes ${suffix}`;
    const renamedCategoryName = `Customer Field Notes ${suffix}`;
    const createdCategorySlug = categoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const categoryBrowseTitle = `Browse Category Rename Target ${suffix}`;
    await createPageViaApi(apiAsAdmin, {
      title: architectureTitle,
      body: 'Seeds the Architecture category for the admin catalog.',
      status: 'draft',
      frontmatter: { categories: ['architecture'] },
    });
    await createPageViaApi(apiAsAdmin, {
      title: fieldResearchTitle,
      body: 'Seeds a unique field-research category for the admin catalog.',
      status: 'draft',
      frontmatter: { categories: [fieldResearchSlug] },
    });

    await signedInPage.goto('/');
    await expect(signedInPage.getByRole('button', { name: /primary categories/i })).toHaveCount(0);

    await signedInPage.getByRole('button', { name: /^admin$/i }).click();
    await expect(signedInPage).toHaveURL(/\/admin$/);
    await signedInPage.getByRole('link', { name: /primary categories/i }).click();

    await expect(signedInPage.getByRole('heading', { name: 'Primary categories', exact: true })).toBeVisible();
    await expect(signedInPage.getByText(/curate the primary category catalog/i)).toBeVisible();
    await expect(signedInPage.getByRole('table', { name: /primary category catalog/i })).toBeVisible();
    await expect(signedInPage.getByRole('row', { name: /architecture/i })).toContainText(/\d+ items?/);
    await expect(signedInPage.getByRole('row', { name: new RegExp(fieldResearchSlug, 'i') })).toContainText('1 item');

    const tableTop = await signedInPage.getByRole('table', { name: /primary category catalog/i }).evaluate((node) => node.getBoundingClientRect().top);
    const createButtonTop = await signedInPage.getByRole('button', { name: /create category/i }).evaluate((node) => node.getBoundingClientRect().top);
    expect(tableTop).toBeLessThan(createButtonTop);

    await signedInPage.getByRole('button', { name: /create category/i }).click();
    const createDialog = signedInPage.getByRole('dialog', { name: /new primary category/i });
    await expect(createDialog).toBeVisible();
    await expect(createDialog.getByRole('button', { name: /^create category$/i })).toBeDisabled();
    await createDialog.getByLabel(/category name/i).fill(categoryName);
    await createDialog.getByRole('button', { name: /^create category$/i }).click();
    await expect(signedInPage.getByRole('status').filter({ hasText: new RegExp(`primary category created: ${categoryName}`, 'i') })).toBeVisible();
    await expect(signedInPage.getByRole('row', { name: new RegExp(categoryName, 'i') })).toContainText('0 items');

    await createPageViaApi(apiAsAdmin, {
      title: categoryBrowseTitle,
      body: 'Browse cards and local search should use the latest category display name.',
      status: 'draft',
      frontmatter: { categories: [createdCategorySlug] },
    });
    await signedInPage.reload();
    await expect(signedInPage.getByRole('row', { name: new RegExp(categoryName, 'i') })).toContainText('1 item');

    await signedInPage.getByRole('button', { name: /create category/i }).click();
    const duplicateDialog = signedInPage.getByRole('dialog', { name: /new primary category/i });
    await duplicateDialog.getByLabel(/category name/i).fill(categoryName);
    await duplicateDialog.getByRole('button', { name: /^create category$/i }).click();
    await expect(duplicateDialog.getByRole('alert')).toContainText(/primary category slug already exists/i);
    await duplicateDialog.getByRole('button', { name: /cancel/i }).click();

    await expect(signedInPage.getByRole('button', { name: new RegExp(`rename category ${categoryName}`, 'i') })).toBeVisible();
    await signedInPage.getByRole('row', { name: new RegExp(categoryName, 'i') }).getByRole('button', { name: /rename category/i }).click();
    const renameDialog = signedInPage.getByRole('dialog', { name: /rename primary category/i });
    await renameDialog.getByLabel(/category name/i).fill(renamedCategoryName);
    await renameDialog.getByRole('button', { name: /^save category$/i }).click();
    await expect(signedInPage.getByRole('row', { name: new RegExp(renamedCategoryName, 'i') })).toContainText('No color/icon metadata yet');
    await expect(signedInPage.getByRole('button', { name: new RegExp(`archive category ${renamedCategoryName}`, 'i') })).toBeDisabled();

    await signedInPage.goto(`/?q=${encodeURIComponent(renamedCategoryName)}`);
    await expect(signedInPage.locator('.PageList__CardTitle').filter({ hasText: categoryBrowseTitle })).toBeVisible();
    await expect(signedInPage.getByText(new RegExp(`Category: ${renamedCategoryName}`, 'i'))).toBeVisible();

    await signedInPage.goto('/admin/primary-categories');
    const unusedCategoryName = `Unused Archive Category ${suffix}`;
    await signedInPage.getByRole('button', { name: /create category/i }).click();
    const unusedDialog = signedInPage.getByRole('dialog', { name: /new primary category/i });
    await unusedDialog.getByLabel(/category name/i).fill(unusedCategoryName);
    await unusedDialog.getByRole('button', { name: /^create category$/i }).click();
    await expect(signedInPage.getByRole('row', { name: new RegExp(unusedCategoryName, 'i') })).toContainText('0 items');
    await signedInPage.getByRole('button', { name: new RegExp(`archive category ${unusedCategoryName}`, 'i') }).click();
    await expect(signedInPage.getByRole('row', { name: new RegExp(unusedCategoryName, 'i') })).toHaveCount(0);
    await expect(signedInPage.getByText(/category archived/i)).toBeVisible();
  });

  test('keeps primary category management out of the article editor', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `category-route-target-${testInfo.workerIndex}-${Date.now()}`;
    const page = await createPageViaApi(apiAsAdmin, {
      title: `Dedicated Category Admin Route Target ${suffix}`,
      body: 'Article editor should remain focused on content editing.',
      status: 'draft',
      frontmatter: { categories: ['architecture'] },
    });

    await signedInPage.goto(`/p/${page.slug}?edit=1`);

    await expect(signedInPage.getByRole('link', { name: /primary categories/i })).toHaveCount(0);
    await expect(signedInPage.getByRole('combobox', { name: /primary category/i })).toHaveCount(0);
    await expect(signedInPage.getByRole('textbox', { name: /category/i })).toHaveCount(0);
  });
});
