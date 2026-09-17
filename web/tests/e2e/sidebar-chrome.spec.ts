import { test, expect } from './fixtures.js';

/**
 * Maps to features/08-app-chrome-and-help.feature.
 *
 * The expand affordance changed shape: the rail used to carry an angles-right
 * button of its own, and the product mark is the control that expands it now.
 * What has NOT changed, and is the point, is that both directions are named —
 * a 56px rail of unlabelled icons is only navigable if every control says what
 * it does.
 */
test.describe('sidebar chrome', () => {
  test('collapse and expand are both named, and collapse uses the angles-left icon', async ({ signedInPage }) => {
    await signedInPage.goto('/');
    const sidebar = signedInPage.locator('.kp-sidebar');
    // The collapse state is persisted to localStorage, so a run can arrive here
    // either way; start from expanded rather than assuming it.
    if ((await sidebar.getAttribute('class'))?.includes('collapsed')) {
      await sidebar.getByRole('button', { name: 'Expand sidebar' }).click();
    }
    await expect(sidebar).toHaveClass(/expanded/);

    const collapse = sidebar.getByRole('button', { name: 'Collapse sidebar' }).last();
    await expect(collapse.locator('svg[data-icon="angles-left"]')).toBeVisible();
    await collapse.click();

    await expect(sidebar).toHaveClass(/collapsed/);
    // Collapsed, the product mark is the way back — and it names itself.
    const expand = sidebar.getByRole('button', { name: 'Expand sidebar' });
    await expect(expand).toBeVisible();
    await expect(expand.locator('.kp-sidebar-logo-img').first()).toBeAttached();
    await expect(sidebar.locator('.kp-sidebar-label')).toHaveCount(0);

    await expand.click();
    await expect(sidebar).toHaveClass(/expanded/);
    await expect(sidebar.getByRole('button', { name: 'Topics' })).toBeVisible();
  });
});
