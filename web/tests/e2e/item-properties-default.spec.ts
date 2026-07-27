import { test, expect, createPageViaApi } from './fixtures.js';

function propertiesDetails(page: import('@playwright/test').Page) {
  return page.locator('.cm-me-properties-details').first();
}

function readPropertiesPanel(page: import('@playwright/test').Page) {
  return page.locator('.kp-item-properties-panel').first();
}

function editorPropertiesToggle(page: import('@playwright/test').Page) {
  return page.locator('.me-properties-toggle').first();
}

function editMetadataRegion(page: import('@playwright/test').Page) {
  return page.getByLabel('Item metadata');
}

test.describe('item properties default display', () => {
  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('read mode hides item properties until explicitly toggled on @quarantine', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `props-read-${testInfo.workerIndex}-${Date.now()}`;
    const item = await createPageViaApi(apiAsAdmin, {
      title: `Read Hidden Properties Item ${suffix}`,
      body: 'Body text for read mode hidden properties.',
      status: 'draft',
      frontmatter: {
        topic: 'Research',
        categories: ['architecture'],
        tags: ['mvp'],
      },
    });

    await signedInPage.goto(`/p/${item.slug}`);

    await expect(readPropertiesPanel(signedInPage)).toHaveCount(0);
    await signedInPage.getByRole('button', { name: /show properties/i }).click();
    await expect(readPropertiesPanel(signedInPage)).toBeVisible();
    await expect(readPropertiesPanel(signedInPage)).toContainText('Research');
    await expect(readPropertiesPanel(signedInPage)).toContainText('mvp');

    await signedInPage.getByRole('button', { name: /hide properties/i }).click();
    await expect(readPropertiesPanel(signedInPage)).toHaveCount(0);
  });

  test('existing item edit opens properties hidden with an explicit toggle', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `props-edit-${testInfo.workerIndex}-${Date.now()}`;
    const item = await createPageViaApi(apiAsAdmin, {
      title: `Collapsed Properties Existing Item ${suffix}`,
      body: 'Body text for collapsed properties.',
      status: 'draft',
      frontmatter: {
        topic: 'Research',
        categories: ['architecture'],
        tags: ['mvp'],
      },
    });

    await signedInPage.goto(`/p/${item.slug}`);
    await signedInPage.getByRole('button', { name: /edit page/i }).click();

    await expect(propertiesDetails(signedInPage)).toHaveCount(0);
    await expect(signedInPage.locator('.cm-me-property-chip[data-property-key="topic"]')).toHaveCount(0);
    await expect(signedInPage.locator('.cm-me-property-input').first()).toHaveCount(0);

    await expect(editMetadataRegion(signedInPage).getByRole('button', { name: /show properties/i })).toHaveCount(0);
    await expect(editorPropertiesToggle(signedInPage)).toBeVisible();
    await expect(editorPropertiesToggle(signedInPage).locator('svg[data-icon="eye"]')).toHaveCount(0);
    await editorPropertiesToggle(signedInPage).click();

    await expect(propertiesDetails(signedInPage)).toHaveJSProperty('open', true);
    await expect(signedInPage.locator('.cm-me-property-input').first()).toBeVisible();

    await editorPropertiesToggle(signedInPage).click();
    await expect(propertiesDetails(signedInPage)).toHaveCount(0);
  });

  test('new item auto-edit also hides properties until explicitly toggled on', async ({ signedInPage }, testInfo) => {
    const suffix = `props-new-${testInfo.workerIndex}-${Date.now()}`;
    await signedInPage.goto('/browse');
    await signedInPage.getByRole('button', { name: /new item/i }).first().click();

    const dialog = signedInPage.getByRole('dialog', { name: /new item composer/i });
    await dialog.getByLabel(/^title/i).fill(`Expanded Properties New Item ${suffix}`);
    await dialog.getByRole('button', { name: /start draft/i }).click();

    await expect(signedInPage).toHaveURL((url) => url.pathname.startsWith('/p/') && Boolean(url.searchParams.get('edit')), {
      timeout: 10_000,
    });
    await expect(propertiesDetails(signedInPage)).toHaveCount(0, { timeout: 15_000 });
    await expect(signedInPage.locator('.cm-me-properties-table').first()).toHaveCount(0);
    await expect(signedInPage.locator('.cm-me-property-input').first()).toHaveCount(0);

    await expect(editMetadataRegion(signedInPage).getByRole('button', { name: /show properties/i })).toHaveCount(0);
    await expect(editorPropertiesToggle(signedInPage)).toBeVisible();
    await expect(editorPropertiesToggle(signedInPage).locator('svg[data-icon="eye"]')).toHaveCount(0);
    await editorPropertiesToggle(signedInPage).click();
    await expect(propertiesDetails(signedInPage)).toHaveJSProperty('open', true, { timeout: 15_000 });
    await expect(signedInPage.locator('.cm-me-properties-table').first()).toBeVisible();
    await expect(signedInPage.locator('.cm-me-property-input').first()).toBeVisible();
  });
});
