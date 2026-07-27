import { test, expect } from './fixtures.js';

test.describe('sidebar chrome', () => {
  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('expand and collapse use angle icons @quarantine', async ({ signedInPage }) => {
    await signedInPage.goto('/');

    const toggle = signedInPage.getByRole('button', { name: /expand sidebar/i });
    await expect(toggle.locator('svg[data-icon="angles-right"]')).toBeVisible();

    await toggle.click();
    const collapseToggle = signedInPage.getByRole('button', { name: /collapse sidebar/i });
    await expect(collapseToggle.locator('svg[data-icon="angles-left"]')).toBeVisible();
  });
});
