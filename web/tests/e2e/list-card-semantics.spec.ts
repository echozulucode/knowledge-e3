import { expect, test, createPageViaApi } from './fixtures.js';

test.describe('browse card semantics', () => {
  test('card primary action is semantic and Space opens the item without breaking nested actions', async ({ signedInPage, apiAsAdmin }) => {
    const item = await createPageViaApi(apiAsAdmin, {
      title: 'Semantic Card Target',
      body: 'A card that should open from a semantic primary action.',
      status: 'published',
    });

    await signedInPage.goto('/browse');
    const card = signedInPage.locator('.PageList__Card').filter({ hasText: 'Semantic Card Target' });
    await expect(card).toBeVisible();
    await expect(card).not.toHaveAttribute('role', 'button');

    const openAction = card.getByRole('button', { name: /open semantic card target/i });
    await expect(openAction).toBeVisible();

    await card.getByRole('button', { name: /edit semantic card target/i }).focus();
    await signedInPage.keyboard.press('Space');
    await expect(signedInPage).toHaveURL(new RegExp(`/p/${item.slug}\\?edit=(?:1|%221%22)`));

    await signedInPage.goto('/browse');
    const reopenedCard = signedInPage.locator('.PageList__Card').filter({ hasText: 'Semantic Card Target' });
    await reopenedCard.getByRole('button', { name: /open semantic card target/i }).focus();
    await signedInPage.keyboard.press('Space');
    await expect(signedInPage).toHaveURL(new RegExp(`/p/${item.slug}`));
  });
});
