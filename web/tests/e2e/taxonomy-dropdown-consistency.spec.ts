import { expect, test } from './fixtures.js';

async function optionLabels(locator: import('@playwright/test').Locator): Promise<string[]> {
  return locator.locator('option').evaluateAll((options) =>
    options.map((option) => option.textContent?.trim() ?? '').filter(Boolean),
  );
}

function sorted(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

test.describe('taxonomy dropdown consistency', () => {
  test('topic drawer and composer dropdowns match the authoritative taxonomy lists', async ({ signedInPage, apiAsAdmin }) => {
    const [topicsResponse, categoriesResponse] = await Promise.all([
      apiAsAdmin.get('/api/v1/topics'),
      apiAsAdmin.get('/api/v1/taxonomy/categories'),
    ]);
    expect(topicsResponse.ok()).toBeTruthy();
    expect(categoriesResponse.ok()).toBeTruthy();
    const topicsBody = await topicsResponse.json();
    const categoriesBody = await categoriesResponse.json();
    const actualTopics = sorted((topicsBody.topics as { name: string }[]).map((topic) => topic.name));
    const actualCategories = sorted((categoriesBody.categories as { name: string }[]).map((category) => category.name));

    await signedInPage.goto('/');

    await signedInPage.getByRole('button', { name: /topic: all topics/i }).click();
    const drawer = signedInPage.getByRole('dialog', { name: /topic directory/i });
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('.TopicSwitcher__TopicName')).toHaveCount(actualTopics.length);
    const drawerTopics = await drawer.locator('.TopicSwitcher__TopicName').allTextContents();
    expect(sorted(drawerTopics)).toEqual(actualTopics);
    await drawer.getByRole('button', { name: /close topic directory/i }).click();

    await signedInPage.getByRole('button', { name: /new item/i }).first().click();
    const composer = signedInPage.getByRole('dialog', { name: /new item composer/i });
    await expect(composer).toBeVisible();

    const composerTopics = (await optionLabels(composer.getByLabel(/^topic$/i))).filter((label) => label !== 'No topic');
    const composerCategories = (await optionLabels(composer.getByLabel(/primary category/i))).filter((label) => label !== 'Choose category…');
    expect(sorted(composerTopics)).toEqual(actualTopics);
    expect(sorted(composerCategories)).toEqual(actualCategories);
  });

  test('composer shows actionable taxonomy help on info icons', async ({ signedInPage }) => {
    await signedInPage.goto('/');
    await signedInPage.getByRole('button', { name: /new item/i }).first().click();
    const composer = signedInPage.getByRole('dialog', { name: /new item composer/i });
    await expect(composer).toBeVisible();

    await composer.locator('[data-help-key="topic"]').click();
    await expect(composer.getByRole('tooltip')).toContainText(/main collection/i);

    await composer.locator('[data-help-key="primary-category"]').click();
    await expect(composer.getByRole('tooltip')).toContainText(/one primary purpose/i);
    await expect(composer.getByRole('tooltip')).toContainText(/extra categories/i);

    await composer.locator('[data-help-key="groups"]').click();
    await expect(composer.getByRole('tooltip')).toContainText(/temporary/i);
  });
});
