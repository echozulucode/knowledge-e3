import { test, expect } from './fixtures.js';

function cardForTitle(page: import('@playwright/test').Page, title: string) {
  return page.locator('.PageList__Card').filter({ has: page.locator('.PageList__CardTitle', { hasText: title }) });
}

test.describe('topic-aware create and edit flows', () => {
  test('defaults new items from the active topic and saves edited topic changes canonically', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `topic-aware-${testInfo.workerIndex}-${Date.now()}`;
    const motorName = `Motor Control ${suffix}`;
    const unrelatedName = `Unrelated Topic ${suffix}`;
    const motorSlug = `motor-control-${suffix}`;
    const unrelatedSlug = `unrelated-topic-${suffix}`;
    const title = `Topic Aware Draft ${suffix}`;

    for (const data of [
      { name: motorName, slug: motorSlug, description: 'Motor control notes' },
      { name: unrelatedName, slug: unrelatedSlug, description: 'Unrelated notes' },
    ]) {
      const res = await apiAsAdmin.post('/api/v1/topics', { data });
      if (!res.ok()) throw new Error(`seed topic failed: ${res.status()} ${await res.text()}`);
    }

    await signedInPage.goto(`/?view=all&topic=${encodeURIComponent(motorSlug)}&q=${encodeURIComponent(suffix)}`);
    await expect(signedInPage.getByRole('button', { name: new RegExp(`topic: ${motorName}`, 'i') })).toBeVisible({ timeout: 15_000 });

    await signedInPage.getByRole('button', { name: /new item/i }).click();
    const composer = signedInPage.getByRole('dialog', { name: /new item composer/i });
    await expect(composer).toBeVisible();
    await expect(composer.getByLabel('Topic')).toHaveValue(motorName);
    await composer.getByLabel('Title').fill(title);
    await composer.getByLabel('Body notes').fill('Created from the motor topic filter.');
    await composer.getByRole('button', { name: /start draft/i }).click();

    await expect(signedInPage).toHaveURL(/\/items\//, { timeout: 15_000 });
    const editTopicSelect = signedInPage.locator('.kp-edit-topic-select select');
    await expect(editTopicSelect).toHaveValue(motorName, { timeout: 15_000 });
    await signedInPage.getByLabel('Item save status').getByRole('button', { name: /^save$/i }).click();
    await expect(signedInPage.getByText(/page saved/i)).toBeVisible({ timeout: 15_000 });

    await signedInPage.goto(`/?view=all&topic=${encodeURIComponent(motorSlug)}&q=${encodeURIComponent(title)}`);
    await expect(cardForTitle(signedInPage, title)).toBeVisible({ timeout: 15_000 });
    await signedInPage.goto(`/?view=all&topic=${encodeURIComponent(unrelatedSlug)}&q=${encodeURIComponent(title)}`);
    await expect(cardForTitle(signedInPage, title)).toHaveCount(0);

    await signedInPage.goto(`/?view=all&topic=${encodeURIComponent(motorSlug)}&q=${encodeURIComponent(title)}`);
    await cardForTitle(signedInPage, title).getByRole('button', { name: new RegExp(`edit ${title}`, 'i') }).click({ force: true });
    await expect(editTopicSelect).toHaveValue(motorName, { timeout: 15_000 });
    await editTopicSelect.selectOption({ label: unrelatedName });
    await signedInPage.getByLabel('Item save status').getByRole('button', { name: /^save$/i }).click();
    await expect(signedInPage.getByText(/page saved/i)).toBeVisible({ timeout: 15_000 });

    await signedInPage.goto(`/?view=all&topic=${encodeURIComponent(motorSlug)}&q=${encodeURIComponent(title)}`);
    await expect(cardForTitle(signedInPage, title)).toHaveCount(0);
    await signedInPage.goto(`/?view=all&topic=${encodeURIComponent(unrelatedSlug)}&q=${encodeURIComponent(title)}`);
    await expect(cardForTitle(signedInPage, title)).toBeVisible({ timeout: 15_000 });
  });
});
