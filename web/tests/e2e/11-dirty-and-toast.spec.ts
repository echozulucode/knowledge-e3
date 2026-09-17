/**
 * Dirty indicator + save toast + error retry.
 *
 * Maps to the UX review plan §3A (No Dirty Indicator) & §3E (No Success/Error Feedback).
 *
 * Test suite validating:
 * 1. Dirty indicator (visual dot on title or document.title) appears on first edit
 * 2. Success toast "Page saved" appears after Cmd+S and auto-dismisses
 * 3. Error toast with Retry button appears on save failure (500 error)
 * 4. Retry button attempts save again
 *
 * The dirty indicator used to be an aria-label="Unsaved changes" element on
 * PageView's edit shell. Compose states it in words in the "Item save status"
 * footer and keeps reflecting it in document.title with a bullet ("•"); the
 * standalone dot went with the shell.
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

    // Compose states the dirty condition in words in the save-status footer and
    // in the document title, rather than with the old standalone dot.
    const saveStatus = signedInPage.getByRole('region', { name: /item save status/i });
    await expect(saveStatus).toBeVisible({ timeout: 15_000 });
    await expect(saveStatus).not.toContainText(/unsaved changes/i);

    // document.title should NOT contain the bullet yet
    let title = await signedInPage.title();
    expect(title).not.toContain('•');

    // Type a character to mark dirty
    const cmContent = signedInPage.locator('.cm-content');
    await cmContent.click();
    await cmContent.type('x');

    await expect(saveStatus).toContainText(/unsaved changes/i, { timeout: 5_000 });
    await expect.poll(() => signedInPage.title(), { timeout: 5_000 }).toContain('•');

    // Save via Cmd+S — handled at the window, so it works from the editor too.
    await signedInPage.keyboard.press('Control+s');

    await expect(saveStatus).toContainText(/^Saved/, { timeout: 15_000 });
    await expect(saveStatus).not.toContainText(/unsaved changes/i);
    await expect.poll(() => signedInPage.title(), { timeout: 5_000 }).not.toContain('•');
  });

  test('success toast "Page saved" appears and auto-dismisses', async ({
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

    // Wait for the success toast to appear. Scope to the toast component
    // (role="status" success): PageView also renders an inline `kp-local-notice`
    // with role="status" for the same event, so a bare [role="status"] matches
    // two elements and trips Playwright strict mode. The toast is what this test
    // is about; the inline notice is covered by the dirty-indicator tests.
    const successToast = signedInPage.locator('.kp-toast-item').filter({
      hasText: /saved|synced/i,
    });
    await expect(successToast).toBeVisible({ timeout: 3000 });

    // Success toasts auto-dismiss after 2500ms (useToast AUTO_DISMISS_MS).
    await expect(successToast).not.toBeVisible({ timeout: 5000 });
  });

  test('error toast appears with Retry button on save failure', async ({
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

    // Wait for the error toast. Scope to the toast component (role="alert"
    // error): PageView also renders an inline `kp-local-notice` with role="alert"
    // for the same error, so a bare [role="alert"] matches two elements and trips
    // strict mode. Error toasts persist until dismissed (useToast).
    const errorToast = signedInPage.locator('.kp-toast-item').filter({
      hasText: /failed|error/i,
    });
    await expect(errorToast).toBeVisible({ timeout: 3000 });

    // Expect a Retry button inside the error toast.
    const retryButton = errorToast.getByRole('button', { name: /retry/i });
    await expect(retryButton).toBeVisible();
  });

  test('Retry button re-attempts save and shows success on recovery', async ({
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

    // Error toast appears (scoped to the toast component — see note above).
    const errorToast = signedInPage.locator('.kp-toast-item').filter({
      hasText: /failed|error/i,
    });
    await expect(errorToast).toBeVisible({ timeout: 3000 });

    // Click the Retry button inside the error toast.
    const retryButton = errorToast.getByRole('button', { name: /retry/i });
    await retryButton.click();

    // Wait for the success toast (the error toast dismisses on retry).
    const successToast = signedInPage.locator('.kp-toast-item').filter({
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

    const saveStatus = signedInPage.getByRole('region', { name: /item save status/i });
    await expect(saveStatus).toContainText(/unsaved changes/i, { timeout: 5_000 });
    await expect.poll(() => signedInPage.title(), { timeout: 5_000 }).toContain('•');

    // Try to save (fails)
    await signedInPage.keyboard.press('Control+s');
    await expect(saveStatus).toContainText(/save failed/i, { timeout: 15_000 });

    // A failed save leaves the document dirty: the title keeps its bullet, so a
    // reader of the tab still knows the edits are not committed.
    await expect.poll(() => signedInPage.title(), { timeout: 5_000 }).toContain('•');
  });
});
