import { test, expect, createPageViaApi } from './fixtures.js';

test.describe('keyboard help section', () => {
  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('top bar no longer shows Search and Help is a normal page @quarantine', async ({ signedInPage }) => {
    await signedInPage.goto('/');

    const header = signedInPage.locator('.kp-header');
    await expect(header.getByRole('button', { name: /^Search$/i })).toHaveCount(0);
    await expect(header.locator('.kp-palette-trigger')).toHaveCount(0);

    await signedInPage.getByRole('button', { name: /^Help$/i }).click();
    await expect(signedInPage).toHaveURL(/\/help$/);

    const help = signedInPage.getByRole('region', { name: /keyboard shortcuts/i });
    await expect(help).toBeVisible();
    await expect(help).toContainText(/Cmd\/Ctrl \+ S/i);
    await expect(help).toContainText(/Cmd\/Ctrl \+ Shift \+ M/i);
    await expect(help).toContainText(/Cmd\/Ctrl \+ B/i);
    await expect(help).toContainText(/Cmd\/Ctrl \+ I/i);
    await expect(signedInPage.getByRole('dialog', { name: /keyboard shortcuts/i })).toHaveCount(0);
  });

  test('Cmd+? navigates to Help instead of opening a popup', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `keyboard-help-section-${testInfo.workerIndex}-${Date.now()}`;
    const p = await createPageViaApi(apiAsAdmin, {
      title: `Keyboard Help Section ${suffix}`,
      body: 'Content.',
      status: 'draft',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    await signedInPage.keyboard.press('Meta+Shift+/');

    await expect(signedInPage).toHaveURL(/\/help$/);
    await expect(signedInPage.getByRole('dialog', { name: /keyboard shortcuts/i })).toHaveCount(0);
    await expect(signedInPage.getByRole('heading', { name: /keyboard shortcuts/i })).toBeVisible();
  });

  test('command palette keyboard-shortcuts entry routes to Help', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `palette-help-section-${testInfo.workerIndex}-${Date.now()}`;
    const p = await createPageViaApi(apiAsAdmin, {
      title: `Command Palette Help Section ${suffix}`,
      body: 'Content.',
      status: 'draft',
    });
    await signedInPage.goto(`/p/${p.slug}`);

    await signedInPage.keyboard.press('Meta+k');
    const palette = signedInPage.locator('.kp-palette-modal');
    await expect(palette).toBeVisible({ timeout: 2000 });

    const shortcutsEntry = signedInPage.locator('button, [role="option"]').filter({
      hasText: /keyboard.*shortcut|shortcut.*keyboard|help/i,
    });
    await expect(shortcutsEntry.first()).toBeVisible();
    await shortcutsEntry.first().click();

    await expect(signedInPage).toHaveURL(/\/help$/);
    await expect(signedInPage.getByRole('dialog', { name: /keyboard shortcuts/i })).toHaveCount(0);
    await expect(signedInPage.getByRole('region', { name: /keyboard shortcuts/i })).toBeVisible();
  });
});
