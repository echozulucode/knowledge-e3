/**
 * Dirty indicator + save toast + error retry.
 *
 * Maps to docs/ux-review-plan.md §3A (No Dirty Indicator) & §3E (No Success/Error Feedback).
 *
 * Test suite validating:
 * 1. Dirty indicator (visual dot on title or document.title) appears on first edit
 * 2. Success toast "Page saved" appears after Cmd+S and auto-dismisses
 * 3. Error toast with Retry button appears on save failure (500 error)
 * 4. Retry button attempts save again
 *
 * The dirty indicator is typically rendered as an aria-label="Unsaved changes"
 * element or reflected in document.title with a bullet ("•").
 */

import { test, expect, createPageViaApi } from './fixtures.js';

test.describe('dirty indicator + save toast', () => {
  test('dirty indicator appears on first keystroke, disappears after save', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'DirtyTest',
      body: 'Initial.',
      status: 'draft',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // Expect NO dirty indicator initially
    const dirtyDot = signedInPage.locator('[aria-label="Unsaved changes"]');
    await expect(dirtyDot).not.toBeVisible();

    // Also check document.title should NOT contain bullet
    let title = await signedInPage.title();
    expect(title).not.toContain('•');

    // Type a character to mark dirty
    const cmContent = signedInPage.locator('.cm-content');
    await cmContent.click();
    await cmContent.type('x');

    // Wait for dirty state to propagate (there's debounce logic)
    await signedInPage.waitForTimeout(100);

    // Expect dirty indicator NOW appears
    // First, check if it's in aria-label
    await expect(dirtyDot).toBeVisible({ timeout: 2000 });

    // Also check document.title now contains bullet
    title = await signedInPage.title();
    expect(title).toContain('•');

    // Save via Cmd+S
    await signedInPage.keyboard.press('Control+s');

    // Wait for save to complete and toast to appear + auto-dismiss
    await signedInPage.waitForTimeout(500);

    // Dirty indicator should disappear
    await expect(dirtyDot).not.toBeVisible({ timeout: 2000 });

    // Title should no longer have bullet
    title = await signedInPage.title();
    expect(title).not.toContain('•');
  });

  // @quarantine (app bug): editor save/sync path hangs — pre-existing, predates the OKF pivot. Test is likely correct; fix the product.
  test('success toast "Page saved" appears and auto-dismisses @quarantine', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'SaveToastTest',
      body: 'Body.',
      status: 'draft',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // Make an edit
    const cmContent = signedInPage.locator('.cm-content');
    await cmContent.click();
    await cmContent.type('test');
    await signedInPage.waitForTimeout(100);

    // Save
    await signedInPage.keyboard.press('Control+s');

    // Wait for success toast to appear
    // Toast is typically role="status" with success message
    const successToast = signedInPage.locator('[role="status"]').filter({
      hasText: /saved|saved|synced/i,
    });
    await expect(successToast).toBeVisible({ timeout: 3000 });

    // Wait for auto-dismiss (typically 3 seconds)
    await expect(successToast).not.toBeVisible({ timeout: 5000 });
  });

  // @quarantine (app bug): editor save/sync path hangs — pre-existing, predates the OKF pivot. Test is likely correct; fix the product.
  test('error toast appears with Retry button on save failure @quarantine', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'ErrorToastTest',
      body: 'Body.',
      status: 'draft',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // Intercept the save API and return 500 error
    await signedInPage.route('**/api/v1/pages/**', async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Internal server error' }),
        });
      } else {
        await route.continue();
      }
    });

    // Make an edit and attempt save
    const cmContent = signedInPage.locator('.cm-content');
    await cmContent.click();
    await cmContent.type('test');
    await signedInPage.waitForTimeout(100);

    // Save (will fail due to interceptor)
    await signedInPage.keyboard.press('Control+s');

    // Wait for error toast to appear
    // Toast is typically role="alert" with error message
    const errorToast = signedInPage.locator('[role="alert"]').filter({
      hasText: /failed|error/i,
    });
    await expect(errorToast).toBeVisible({ timeout: 3000 });

    // Expect a Retry button inside or near the error toast
    const retryButton = signedInPage
      .locator('[role="alert"]')
      .filter({ hasText: /failed|error/i })
      .getByRole('button', { name: /retry/i });
    await expect(retryButton).toBeVisible();
  });

  // @quarantine (app bug): editor save/sync path hangs — pre-existing, predates the OKF pivot. Test is likely correct; fix the product.
  test('Retry button re-attempts save and shows success on recovery @quarantine', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'RetryTest',
      body: 'Body.',
      status: 'draft',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    let failCount = 0;
    // First request fails (500), second succeeds
    await signedInPage.route('**/api/v1/pages/**', async (route) => {
      if (route.request().method() === 'PUT') {
        failCount++;
        if (failCount === 1) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Transient error' }),
          });
        } else {
          // Second attempt succeeds
          await route.continue();
        }
      } else {
        await route.continue();
      }
    });

    // Edit and save (first attempt fails)
    const cmContent = signedInPage.locator('.cm-content');
    await cmContent.click();
    await cmContent.type('test');
    await signedInPage.waitForTimeout(100);

    await signedInPage.keyboard.press('Control+s');

    // Error toast appears
    const errorToast = signedInPage.locator('[role="alert"]').filter({
      hasText: /failed|error/i,
    });
    await expect(errorToast).toBeVisible({ timeout: 3000 });

    // Click Retry button
    const retryButton = signedInPage
      .locator('[role="alert"]')
      .filter({ hasText: /failed|error/i })
      .getByRole('button', { name: /retry/i });
    await retryButton.click();

    // Wait for success toast (error toast should be gone)
    const successToast = signedInPage.locator('[role="status"]').filter({
      hasText: /saved|synced/i,
    });
    await expect(successToast).toBeVisible({ timeout: 3000 });
  });

  test('dirty dot reflects unsaved state after error', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'DirtyAfterError',
      body: 'Body.',
      status: 'draft',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // Intercept and fail all saves
    await signedInPage.route('**/api/v1/pages/**', async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Server error' }),
        });
      } else {
        await route.continue();
      }
    });

    // Edit
    const cmContent = signedInPage.locator('.cm-content');
    await cmContent.click();
    await cmContent.type('test');
    await signedInPage.waitForTimeout(100);

    // Dirty indicator should appear
    const dirtyDot = signedInPage.locator('[aria-label="Unsaved changes"]');
    await expect(dirtyDot).toBeVisible({ timeout: 2000 });

    // Try to save (fails)
    await signedInPage.keyboard.press('Control+s');
    await signedInPage.waitForTimeout(500);

    // Dirty indicator should STILL be visible (edits not saved)
    await expect(dirtyDot).toBeVisible();

    // Title should still have bullet
    const title = await signedInPage.title();
    expect(title).toContain('•');
  });
});
