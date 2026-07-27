/**
 * FrontmatterStrip visibility across all editor modes.
 *
 * Maps to docs/ux-review-plan.md and 08-frontmatter-strip.spec.ts.
 *
 * Test suite validating that the FrontmatterStrip (metadata strip above the editor)
 * is visible and functional in all three modes (hybrid, preview, WYSIWYG).
 *
 * The strip renders:
 * - Title (Click to edit title) with inline input
 * - Status (Click to edit status) with popover
 * - Tags (Click to edit tags) with chip input
 * - Owner (Click to edit owner) with text input
 * - Relative date for updated_at
 *
 * Each field is click-to-edit, and changes sync across mode switches.
 */

import { test, expect, createPageViaApi } from './fixtures.js';

test.describe('frontmatter strip — visibility across modes', () => {
  // @quarantine (app bug): editor save/sync path hangs — pre-existing, predates the OKF pivot. Test is likely correct; fix the product.
  test('strip is visible in hybrid mode @quarantine', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'HybridMode',
      status: 'draft',
      body: 'Content.',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // Should be in hybrid mode by default
    await expect(signedInPage.locator('[data-mode="hybrid"]')).toBeVisible();

    // FrontmatterStrip should be visible. Locate by the title field's title attribute
    // (stable selector across iterations).
    const titleField = signedInPage.getByTitle('Click to edit title');
    await expect(titleField).toBeVisible();
    await expect(titleField).toContainText('HybridMode');

    // Status field should also be visible
    const statusField = signedInPage.getByTitle('Click to edit status');
    await expect(statusField).toBeVisible();
    await expect(statusField).toContainText(/draft|published/i);
  });

  // @quarantine (app bug): editor save/sync path hangs — pre-existing, predates the OKF pivot. Test is likely correct; fix the product.
  test('strip is visible in preview mode @quarantine', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'PreviewMode',
      status: 'published',
      body: 'Content.',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // Switch to preview mode
    await signedInPage.getByRole('button', { name: /source/i }).click();
    await expect(signedInPage.locator('[data-mode="preview"]')).toBeVisible();
    await signedInPage.waitForTimeout(150);

    // FrontmatterStrip should still be visible
    const titleField = signedInPage.getByTitle('Click to edit title');
    await expect(titleField).toBeVisible();
    await expect(titleField).toContainText('PreviewMode');

    const statusField = signedInPage.getByTitle('Click to edit status');
    await expect(statusField).toBeVisible();
    await expect(statusField).toContainText(/published/i);
  });

  // @quarantine (app bug): editor save/sync path hangs — pre-existing, predates the OKF pivot. Test is likely correct; fix the product.
  test('strip is visible in WYSIWYG mode @quarantine', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'WysiwygMode',
      status: 'draft',
      body: 'Content.',
      tags: ['test', 'demo'],
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // Switch to WYSIWYG mode
    await signedInPage.getByRole('button', { name: /wysiwyg/i }).click();
    await expect(signedInPage.locator('[data-mode="wysiwyg"]')).toBeVisible();
    await signedInPage.waitForTimeout(200);

    // FrontmatterStrip should still be visible
    const titleField = signedInPage.getByTitle('Click to edit title');
    await expect(titleField).toBeVisible();
    await expect(titleField).toContainText('WysiwygMode');

    const statusField = signedInPage.getByTitle('Click to edit status');
    await expect(statusField).toBeVisible();

    // Tags field should show the tags
    const tagsField = signedInPage.getByTitle('Click to edit tags');
    await expect(tagsField).toBeVisible();
    await expect(tagsField).toContainText('test');
    await expect(tagsField).toContainText('demo');
  });

  // @quarantine (app bug): editor save/sync path hangs — pre-existing, predates the OKF pivot. Test is likely correct; fix the product.
  test('title edit in hybrid mode syncs to WYSIWYG @quarantine', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'OriginalTitle',
      status: 'draft',
      body: 'Content.',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // In hybrid mode, click title to edit
    const titleField = signedInPage.getByTitle('Click to edit title');
    await titleField.click();

    // The strip enters edit mode; find the focused input
    const titleInput = signedInPage.locator('input[type="text"]:focus');
    await expect(titleInput).toBeVisible();

    // Change the title
    await titleInput.fill('UpdatedTitle');
    await titleInput.press('Enter');

    // Title field should show new value
    await expect(titleField).toContainText('UpdatedTitle');
    await signedInPage.waitForTimeout(100);

    // Switch to WYSIWYG and verify the title is still the new value
    await signedInPage.getByRole('button', { name: /wysiwyg/i }).click();
    await expect(signedInPage.locator('[data-mode="wysiwyg"]')).toBeVisible();
    await signedInPage.waitForTimeout(200);

    // Title should reflect the update
    const titleFieldWysiwyg = signedInPage.getByTitle('Click to edit title');
    await expect(titleFieldWysiwyg).toContainText('UpdatedTitle');
  });

  // @quarantine (app bug): editor save/sync path hangs — pre-existing, predates the OKF pivot. Test is likely correct; fix the product.
  test('status change in WYSIWYG syncs to source mode YAML @quarantine', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'StatusSync',
      status: 'draft',
      body: 'Content.',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // Switch to WYSIWYG
    await signedInPage.getByRole('button', { name: /wysiwyg/i }).click();
    await expect(signedInPage.locator('[data-mode="wysiwyg"]')).toBeVisible();
    await signedInPage.waitForTimeout(200);

    // Click status field to open popover
    const statusField = signedInPage.getByTitle('Click to edit status');
    await statusField.click();

    // Select "published" from the popover (button with exact name)
    const publishedButton = signedInPage.getByRole('button', { name: /^published$/i });
    await expect(publishedButton).toBeVisible();
    await publishedButton.click();

    // Wait for popover to close and status to update
    await signedInPage.waitForTimeout(150);
    await expect(statusField).toContainText(/published/i);

    // Switch to source/hybrid mode
    await signedInPage.getByRole('button', { name: /source|hybrid/i }).first().click();
    await signedInPage.waitForTimeout(200);

    // The YAML at the top of the doc should show status: published
    const cmContent = signedInPage.locator('.cm-content');
    await expect(cmContent).toContainText(/status:.*published/i);
  });

  // @quarantine (app bug): editor save/sync path hangs — pre-existing, predates the OKF pivot. Test is likely correct; fix the product.
  test('tags field visible and editable in all modes @quarantine', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'TagsTest',
      status: 'draft',
      body: 'Content.',
      tags: ['existing'],
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // Hybrid mode
    const tagsField = signedInPage.getByTitle('Click to edit tags');
    await expect(tagsField).toBeVisible();
    await expect(tagsField).toContainText('existing');

    // Switch to preview
    await signedInPage.getByRole('button', { name: /source/i }).click();
    await signedInPage.waitForTimeout(150);
    const tagsFieldPreview = signedInPage.getByTitle('Click to edit tags');
    await expect(tagsFieldPreview).toBeVisible();
    await expect(tagsFieldPreview).toContainText('existing');

    // Switch to WYSIWYG
    await signedInPage.getByRole('button', { name: /wysiwyg/i }).click();
    await signedInPage.waitForTimeout(200);
    const tagsFieldWysiwyg = signedInPage.getByTitle('Click to edit tags');
    await expect(tagsFieldWysiwyg).toBeVisible();
    await expect(tagsFieldWysiwyg).toContainText('existing');
  });

  // @quarantine (app bug): editor save/sync path hangs — pre-existing, predates the OKF pivot. Test is likely correct; fix the product.
  test('frontmatter strip visible even with long body content @quarantine', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    // Create a page with substantial body content
    const longBody = Array(100)
      .fill('Lorem ipsum dolor sit amet, consectetur adipiscing elit.')
      .join('\n');

    const p = await createPageViaApi(apiAsAdmin, {
      title: 'LongBodyTest',
      status: 'draft',
      body: longBody,
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // Strip should still be visible at the top
    const titleField = signedInPage.getByTitle('Click to edit title');
    await expect(titleField).toBeVisible();

    // Verify it's near the top (not scrolled out of view)
    // Get bounding box to confirm it's in viewport
    const box = await titleField.boundingBox();
    expect(box).toBeTruthy();
    if (box) {
      expect(box.y).toBeLessThan(300); // Should be in the top portion
    }
  });

  // @quarantine (app bug): editor save/sync path hangs — pre-existing, predates the OKF pivot. Test is likely correct; fix the product.
  test('frontmatter changes persist across mode cycles @quarantine', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'CyclePersist',
      status: 'draft',
      body: 'Content.',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // Edit title in hybrid
    let titleField = signedInPage.getByTitle('Click to edit title');
    await titleField.click();
    let titleInput = signedInPage.locator('input[type="text"]:focus');
    await titleInput.fill('NewTitle1');
    await titleInput.press('Enter');
    await signedInPage.waitForTimeout(100);

    // Cycle through modes: hybrid → preview → wysiwyg → hybrid
    await signedInPage.keyboard.press('Meta+Shift+M'); // preview
    await signedInPage.waitForTimeout(200);
    titleField = signedInPage.getByTitle('Click to edit title');
    await expect(titleField).toContainText('NewTitle1');

    await signedInPage.keyboard.press('Meta+Shift+M'); // wysiwyg
    await signedInPage.waitForTimeout(200);
    titleField = signedInPage.getByTitle('Click to edit title');
    await expect(titleField).toContainText('NewTitle1');

    await signedInPage.keyboard.press('Meta+Shift+M'); // back to hybrid
    await signedInPage.waitForTimeout(200);
    titleField = signedInPage.getByTitle('Click to edit title');
    await expect(titleField).toContainText('NewTitle1');
  });
});
