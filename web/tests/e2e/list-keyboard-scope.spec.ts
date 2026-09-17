import { expect, test, createPageViaApi } from './fixtures.js';

/**
 * j/k move the card focus, but only when the browse surface owns the keyboard.
 *
 * The half of this file that drove the modal new-item composer went with the
 * composer itself (creation is `/new` now). The promise that matters is
 * unchanged and is the reason single-letter shortcuts are dangerous at all: a
 * letter typed into a control is a letter, not a command.
 */

async function focusedCardTitle(page: import('@playwright/test').Page) {
  return page.locator('.PageList__Card.focused .PageList__CardTitle').textContent();
}

test.describe('browse keyboard shortcut scope', () => {
  test('j/k do not fire from the browse controls', async ({ signedInPage, apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, { title: 'Keyboard Scope A', body: 'Alpha', status: 'published' });
    await createPageViaApi(apiAsAdmin, { title: 'Keyboard Scope B', body: 'Bravo', status: 'published' });

    await signedInPage.goto('/browse?view=grouped');
    await expect.poll(() => signedInPage.locator('.PageList__Card').count()).toBeGreaterThanOrEqual(2);

    // A text field takes the letter as text.
    const pageSearch = signedInPage.getByLabel('Search items on this page');
    await pageSearch.click();
    await pageSearch.press('j');
    await expect(pageSearch).toHaveValue('j');
    await expect(signedInPage.locator('.PageList__Card.focused')).toHaveCount(0);
    await pageSearch.fill('');

    // So does a button: focus stays put and no card is selected behind it.
    const newItemButton = signedInPage.getByRole('button', { name: /new item/i }).first();
    await newItemButton.focus();
    await signedInPage.keyboard.press('j');
    await expect(newItemButton).toBeFocused();
    await expect(signedInPage.locator('.PageList__Card.focused')).toHaveCount(0);
  });

  test('j/k still move card focus when the browse surface owns focus', async ({ signedInPage, apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, { title: 'Keyboard Move A', body: 'Alpha', status: 'published' });
    await createPageViaApi(apiAsAdmin, { title: 'Keyboard Move B', body: 'Bravo', status: 'published' });

    await signedInPage.goto('/browse?view=grouped');
    await expect.poll(() => signedInPage.locator('.PageList__Card').count()).toBeGreaterThanOrEqual(2);

    await signedInPage.getByLabel(/grouped browse results/i).focus();
    // A modified key is somebody else's shortcut, never ours.
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
