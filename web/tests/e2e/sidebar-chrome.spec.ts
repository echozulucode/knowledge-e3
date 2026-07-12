import { test, expect } from './fixtures.js';

test.describe('sidebar chrome', () => {
  test('expand and collapse use angle icons', async ({ signedInPage }) => {
    await signedInPage.goto('/');

    const toggle = signedInPage.getByRole('button', { name: /expand sidebar/i });
    await expect(toggle.locator('svg[data-icon="angles-right"]')).toBeVisible();

    await toggle.click();
    const collapseToggle = signedInPage.getByRole('button', { name: /collapse sidebar/i });
    await expect(collapseToggle.locator('svg[data-icon="angles-left"]')).toBeVisible();
  });
});
