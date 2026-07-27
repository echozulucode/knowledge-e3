import { expect, test, createPageViaApi } from './fixtures.js';

async function focusedCardTitle(page: import('@playwright/test').Page) {
  return page.locator('.PageList__Card.focused .PageList__CardTitle').textContent();
}

test.describe('browse keyboard shortcut scope', () => {
  test('j/k shortcuts do not fire from controls or the new-item composer', async ({ signedInPage, apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, { title: 'Keyboard Scope A', body: 'Alpha', status: 'published' });
    await createPageViaApi(apiAsAdmin, { title: 'Keyboard Scope B', body: 'Bravo', status: 'published' });

    await signedInPage.goto('/browse');
    await expect.poll(() => signedInPage.locator('.PageList__Card').count()).toBeGreaterThanOrEqual(2);

    const newItemButton = signedInPage.getByRole('button', { name: /new item/i }).first();
    await newItemButton.focus();
    await signedInPage.keyboard.press('j');
    await expect(signedInPage.locator('.PageList__Card.focused')).toHaveCount(0);

    await signedInPage.keyboard.press('Escape');
    await newItemButton.click();
    await expect(signedInPage.getByRole('dialog', { name: /new item composer/i })).toBeVisible();

    const titleInput = signedInPage.getByPlaceholder('Name this item');
    await expect(titleInput).toBeFocused();
    await titleInput.press('j');
    await expect(titleInput).toHaveValue('j');
    await expect(signedInPage.locator('.PageList__Card.focused')).toHaveCount(0);

    const statusSelect = signedInPage.getByLabel('Status');
    await statusSelect.focus();
    await signedInPage.keyboard.press('j');
    await expect(statusSelect).toBeFocused();
    await expect(signedInPage.locator('.PageList__Card.focused')).toHaveCount(0);
  });

  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('j/k shortcuts still move card focus when the browse surface owns focus @quarantine', async ({ signedInPage, apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, { title: 'Keyboard Move A', body: 'Alpha', status: 'published' });
    await createPageViaApi(apiAsAdmin, { title: 'Keyboard Move B', body: 'Bravo', status: 'published' });

    await signedInPage.goto('/browse');
    await expect.poll(() => signedInPage.locator('.PageList__Card').count()).toBeGreaterThanOrEqual(2);

    await signedInPage.getByLabel(/grouped browse results/i).focus();
    await signedInPage.keyboard.press('Control+J');
    await expect(signedInPage.locator('.PageList__Card.focused')).toHaveCount(0);

    await signedInPage.keyboard.press('j');
    await expect(signedInPage.locator('.PageList__Card.focused')).toHaveCount(1);
    const first = await focusedCardTitle(signedInPage);

    await signedInPage.keyboard.press('j');
    await expect(signedInPage.locator('.PageList__Card.focused')).toHaveCount(1);
    const second = await focusedCardTitle(signedInPage);
    expect(second).not.toBe(first);

    await signedInPage.keyboard.press('k');
    await expect.poll(() => focusedCardTitle(signedInPage)).toBe(first);
  });
});
