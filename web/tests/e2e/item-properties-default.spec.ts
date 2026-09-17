import { test, expect, createPageViaApi } from './fixtures.js';

/**
 * Properties are collapsed until asked for.
 *
 * The read-mode half of this file went with PageView's edit shell: the read page
 * no longer has a "Show properties" toggle at all — properties live in the right
 * context pane's Properties tab, which topic-landing and PageView's own rail
 * cover. What survives is the EDITOR's promise, which Compose still keeps: an
 * item opens on its prose, and the property table is one deliberate click away.
 */

function propertiesDetails(page: import('@playwright/test').Page) {
  return page.locator('.cm-me-properties-details').first();
}

function editorPropertiesToggle(page: import('@playwright/test').Page) {
  return page.locator('.me-properties-toggle').first();
}

test.describe('item properties default display', () => {
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

    await expect(editorPropertiesToggle(signedInPage)).toBeVisible({ timeout: 15_000 });
    await expect(editorPropertiesToggle(signedInPage).locator('svg[data-icon="eye"]')).toHaveCount(0);
    await editorPropertiesToggle(signedInPage).click();

    await expect(propertiesDetails(signedInPage)).toHaveJSProperty('open', true);
    await expect(signedInPage.locator('.cm-me-property-input').first()).toBeVisible();

    await editorPropertiesToggle(signedInPage).click();
    await expect(propertiesDetails(signedInPage)).toHaveCount(0);
  });

  test('a brand-new draft also hides properties until explicitly toggled on', async ({ signedInPage }, testInfo) => {
    const suffix = `props-new-${testInfo.workerIndex}-${Date.now()}`;

    // Creation is a route now (plan §4.1), not a modal over browse.
    await signedInPage.goto('/new?type=concept');
    await signedInPage.getByRole('textbox', { name: 'Title', exact: true }).fill(`Expanded Properties New Item ${suffix}`);

    await expect(propertiesDetails(signedInPage)).toHaveCount(0, { timeout: 15_000 });
    await expect(signedInPage.locator('.cm-me-properties-table').first()).toHaveCount(0);
    await expect(signedInPage.locator('.cm-me-property-input').first()).toHaveCount(0);

    await expect(editorPropertiesToggle(signedInPage)).toBeVisible();
    await expect(editorPropertiesToggle(signedInPage).locator('svg[data-icon="eye"]')).toHaveCount(0);
    await editorPropertiesToggle(signedInPage).click();
    await expect(propertiesDetails(signedInPage)).toHaveJSProperty('open', true, { timeout: 15_000 });
    await expect(signedInPage.locator('.cm-me-properties-table').first()).toBeVisible();
    await expect(signedInPage.locator('.cm-me-property-input').first()).toBeVisible();
  });
});
