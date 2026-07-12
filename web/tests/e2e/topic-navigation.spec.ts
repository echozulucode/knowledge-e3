import { test, expect, createPageViaApi } from './fixtures.js';

function cardForTitle(page: import('@playwright/test').Page, title: string) {
  return page.locator('.PageList__Card').filter({ has: page.locator('.PageList__CardTitle', { hasText: title }) });
}

test.describe('topic navigation drawer', () => {
  test('switches topics through the directory drawer, persists URL state, restores after refresh, and clears to All topics', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `topic-nav-${testInfo.workerIndex}-${Date.now()}`;
    const researchName = `Research Lab ${suffix}`;
    const productName = `Product Lab ${suffix}`;
    const researchSlug = `research-lab-${suffix}`;
    const productSlug = `product-lab-${suffix}`;

    for (const data of [
      { name: researchName, slug: researchSlug, description: 'Research notes and evidence' },
      { name: productName, slug: productSlug, description: 'Product bets and delivery' },
    ]) {
      const res = await apiAsAdmin.post('/api/v1/topics', { data });
      if (!res.ok()) throw new Error(`seed topic failed: ${res.status()} ${await res.text()}`);
    }

    await createPageViaApi(apiAsAdmin, {
      title: `Research Topic Card ${suffix}`,
      status: 'published',
      body: 'Research drawer filter target.',
      frontmatter: { topic: researchName },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `Product Topic Card ${suffix}`,
      status: 'published',
      body: 'Product drawer filter target.',
      frontmatter: { topic: productName },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `Unassigned Topic Card ${suffix}`,
      status: 'published',
      body: 'No topic frontmatter.',
      frontmatter: {},
    });

    await signedInPage.goto(`/?view=all&q=${encodeURIComponent(suffix)}`);
    await expect(signedInPage.getByRole('button', { name: /topic: all topics/i })).toBeVisible({ timeout: 15_000 });
    await expect(cardForTitle(signedInPage, `Research Topic Card ${suffix}`)).toBeVisible();
    await expect(cardForTitle(signedInPage, `Product Topic Card ${suffix}`)).toBeVisible();

    await signedInPage.getByRole('button', { name: /topic: all topics/i }).click();
    const drawer = signedInPage.getByRole('dialog', { name: /topic directory/i });
    await expect(drawer).toBeVisible();
    const topicNames = await drawer.locator('.TopicSwitcher__TopicName').allTextContents();
    expect(new Set(topicNames).size).toBe(topicNames.length);
    await expect(drawer.getByRole('button', { name: /^all topics/i })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: /^unassigned/i })).toHaveCount(0);
    await drawer.getByPlaceholder(/search topics/i).fill('research');
    const researchTopicButton = drawer.locator('.TopicSwitcher__TopicButton').filter({ hasText: researchName });
    await expect(researchTopicButton).toContainText('1 item');
    await researchTopicButton.click();

    await expect(signedInPage).toHaveURL((url) => url.searchParams.get('topic') === researchSlug && url.searchParams.get('q') === suffix && !url.searchParams.has('space'));
    await expect(signedInPage.getByRole('button', { name: new RegExp(`topic: ${researchName}`, 'i') })).toBeVisible();
    await expect(cardForTitle(signedInPage, `Research Topic Card ${suffix}`)).toBeVisible();
    await expect(cardForTitle(signedInPage, `Product Topic Card ${suffix}`)).toHaveCount(0);

    await signedInPage.reload();
    await expect(signedInPage.getByRole('button', { name: new RegExp(`topic: ${researchName}`, 'i') })).toBeVisible({ timeout: 15_000 });
    await expect(cardForTitle(signedInPage, `Research Topic Card ${suffix}`)).toBeVisible();
    await expect(cardForTitle(signedInPage, `Product Topic Card ${suffix}`)).toHaveCount(0);

    await signedInPage.getByLabel('Active browse filters').getByRole('button', { name: new RegExp(`remove topic filter ${researchName}`, 'i') }).click();
    await expect(signedInPage).toHaveURL((url) => url.searchParams.get('q') === suffix && !url.searchParams.has('topic') && !url.searchParams.has('space'));
    await expect(cardForTitle(signedInPage, `Research Topic Card ${suffix}`)).toBeVisible();
    await expect(cardForTitle(signedInPage, `Product Topic Card ${suffix}`)).toBeVisible();

    await signedInPage.getByRole('button', { name: /topic: all topics/i }).click();
    await signedInPage.getByRole('dialog', { name: /topic directory/i }).getByPlaceholder(/search topics/i).fill('unassigned');
    await expect(signedInPage.getByRole('dialog', { name: /topic directory/i }).getByText(/no topics match/i)).toBeVisible();
  });
});
