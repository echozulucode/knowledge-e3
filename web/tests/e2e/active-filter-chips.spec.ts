import { expect, test, createPageViaApi } from './fixtures.js';

test.describe('active browse filter chips', () => {
  test('removing one chip preserves the other active filters and updates results', async ({ signedInPage, apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, {
      title: 'Filter Alpha Target',
      body: 'Alpha body',
      status: 'published',
      tags: ['ux-chip'],
      frontmatter: { categories: ['research-notes'] },
    });
    await createPageViaApi(apiAsAdmin, {
      title: 'Filter Beta Same Tag',
      body: 'Beta body',
      status: 'published',
      tags: ['ux-chip'],
      frontmatter: { categories: ['implementation-notes'] },
    });

    await signedInPage.goto('/?view=all&tag=ux-chip&category=research-notes');
    await expect(signedInPage.locator('.PageList__Card').filter({ hasText: 'Filter Alpha Target' })).toBeVisible();
    await expect(signedInPage.locator('.PageList__Card').filter({ hasText: 'Filter Beta Same Tag' })).toHaveCount(0);

    await signedInPage.getByRole('button', { name: /remove category filter research-notes/i }).click();

    await expect(signedInPage).toHaveURL(/tag=ux-chip/);
    await expect(signedInPage).not.toHaveURL(/category=research-notes/);
    await expect(signedInPage.locator('.PageList__Card').filter({ hasText: 'Filter Alpha Target' })).toBeVisible();
    await expect(signedInPage.locator('.PageList__Card').filter({ hasText: 'Filter Beta Same Tag' })).toBeVisible();
    await expect(signedInPage.getByRole('button', { name: /remove tag filter ux-chip/i })).toBeVisible();
  });
});
