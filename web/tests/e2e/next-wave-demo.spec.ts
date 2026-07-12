import { test, expect, createPageViaApi } from './fixtures.js';

function cardForTitle(page: import('@playwright/test').Page, title: string) {
  return page.locator('.PageList__Card').filter({ has: page.locator('.PageList__CardTitle', { hasText: title }) });
}

function propertiesDetails(page: import('@playwright/test').Page) {
  return page.locator('.cm-me-properties-details').first();
}

async function installClipboardShim(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        lastText: '',
        async writeText(text: string) {
          this.lastText = text;
        },
        async readText() {
          return this.lastText;
        },
      },
    });
  });
}

test.describe('next-wave batch demo smoke', () => {
  test('covers copyable content, collapsed properties, Topic filtering, URL restore, and topic-aware create', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `next-wave-${testInfo.workerIndex}-${Date.now()}`;
    const demoTopicName = `Demo Operations ${suffix}`;
    const demoTopicSlug = `demo-operations-${suffix}`;
    const archiveTopicName = `Archive Research ${suffix}`;
    const archiveTopicSlug = `archive-research-${suffix}`;
    const longArticleTitle = `Next Wave Long Article ${suffix}`;
    const createdTitle = `Topic Seeded Draft ${suffix}`;
    const installCommand = `pnpm --filter @echozedlabs/web demo:${suffix}`;
    const gateCommand = `pnpm -r build && pnpm -r typecheck && pnpm -r test # ${suffix}`;

    for (const data of [
      { name: demoTopicName, slug: demoTopicSlug, description: 'Demo operations and review commands' },
      { name: archiveTopicName, slug: archiveTopicSlug, description: 'Unrelated archive research' },
    ]) {
      const res = await apiAsAdmin.post('/api/v1/topics', { data });
      if (!res.ok()) throw new Error(`seed topic failed: ${res.status()} ${await res.text()}`);
    }

    const longArticle = await createPageViaApi(apiAsAdmin, {
      title: longArticleTitle,
      status: 'published',
      body: [
        '## Deployment context',
        '',
        'This intentionally long article gives enough prose to prove the copy affordance does not depend on a tiny command-only summary.',
        '',
        'Review the rollout notes, verify the preview environment, and keep this body readable as normal article content.',
        '',
        'The exact commands remain authored in frontmatter so cards and the article page can copy them without rewriting markdown.',
      ].join('\n'),
      frontmatter: {
        topic: demoTopicName,
        status: 'published',
        summary: 'Long review article with explicit copy commands rather than a command-shaped summary.',
        copy: [
          { label: 'Install command', value: installCommand },
          { label: 'Run gate', value: gateCommand },
        ],
      },
    });

    await createPageViaApi(apiAsAdmin, {
      title: `Archive Only Article ${suffix}`,
      status: 'published',
      body: 'This article should disappear under the demo topic filter.',
      frontmatter: { topic: archiveTopicName },
    });

    await signedInPage.goto(`/?view=all&q=${encodeURIComponent(suffix)}`);
    await installClipboardShim(signedInPage);

    const longArticleCard = cardForTitle(signedInPage, longArticleTitle);
    await expect(longArticleCard).toBeVisible({ timeout: 15_000 });
    await expect(longArticleCard).toContainText('Long review article with explicit copy commands');
    await expect(longArticleCard.getByRole('button', { name: new RegExp(`copy command from ${longArticleTitle}`, 'i') })).toHaveCount(0);

    await longArticleCard.getByRole('button', { name: new RegExp(`copy install command from ${longArticleTitle}`, 'i') }).click();
    await expect(signedInPage).toHaveURL((url) => url.pathname === '/' && url.searchParams.get('q') === suffix);
    await expect.poll(() => signedInPage.evaluate(() => navigator.clipboard.readText())).toBe(installCommand);

    await longArticleCard.getByRole('button', { name: new RegExp(`open ${longArticleTitle}`, 'i') }).focus();
    await signedInPage.keyboard.press('Space');
    await expect(signedInPage).toHaveURL((url) => url.pathname === `/items/${longArticle.id}` && !url.searchParams.has('edit'), { timeout: 10_000 });
    await installClipboardShim(signedInPage);
    const copyableRegion = signedInPage.getByRole('region', { name: /copyable content/i });
    await expect(copyableRegion).toBeVisible({ timeout: 15_000 });
    await expect(copyableRegion).toContainText('Install command');
    await expect(copyableRegion).toContainText('Run gate');
    await signedInPage.getByRole('button', { name: /copy run gate/i }).click();
    await expect.poll(() => signedInPage.evaluate(() => navigator.clipboard.readText())).toBe(gateCommand);

    await signedInPage.getByRole('button', { name: /edit page/i }).click();
    await expect(signedInPage.getByRole('button', { name: /show properties/i }).first()).toBeVisible({ timeout: 15_000 });
    await expect(propertiesDetails(signedInPage)).toHaveCount(0);
    await expect(signedInPage.locator('.cm-me-property-input').first()).toHaveCount(0);
    await signedInPage.getByRole('button', { name: /show properties/i }).first().click();
    await expect(propertiesDetails(signedInPage)).toHaveJSProperty('open', true, { timeout: 15_000 });
    await expect(signedInPage.locator('.cm-me-property-chip[data-property-key="topic"]')).toContainText(demoTopicName);
    await expect(signedInPage.locator('.cm-me-property-input').first()).toBeVisible();

    await signedInPage.goto(`/?view=all&q=${encodeURIComponent(suffix)}`);
    await expect(signedInPage.getByRole('button', { name: /topic: all topics/i })).toBeVisible({ timeout: 15_000 });
    await signedInPage.getByRole('button', { name: /topic: all topics/i }).click();
    const drawer = signedInPage.getByRole('dialog', { name: /topic directory/i });
    await expect(drawer).toBeVisible();
    await drawer.getByPlaceholder(/search topics/i).fill('demo operations');
    await drawer.getByRole('button', { name: new RegExp(`^${demoTopicName}\\b`, 'i') }).click();
    await expect(signedInPage).toHaveURL((url) => url.searchParams.get('topic') === demoTopicSlug && url.searchParams.get('q') === suffix && !url.searchParams.has('space'));
    await expect(signedInPage.getByRole('button', { name: new RegExp(`topic: ${demoTopicName}`, 'i') })).toBeVisible();
    await expect(cardForTitle(signedInPage, longArticleTitle)).toBeVisible();
    await expect(cardForTitle(signedInPage, `Archive Only Article ${suffix}`)).toHaveCount(0);

    await signedInPage.reload();
    await expect(signedInPage.getByRole('button', { name: new RegExp(`topic: ${demoTopicName}`, 'i') })).toBeVisible({ timeout: 15_000 });
    await expect(cardForTitle(signedInPage, longArticleTitle)).toBeVisible();
    await expect(cardForTitle(signedInPage, `Archive Only Article ${suffix}`)).toHaveCount(0);

    await signedInPage.getByRole('button', { name: /new item/i }).click();
    const composer = signedInPage.getByRole('dialog', { name: /new item composer/i });
    await expect(composer).toBeVisible();
    await expect(composer.getByLabel('Topic')).toHaveValue(demoTopicName);
    await composer.getByLabel('Title').fill(createdTitle);
    await composer.getByLabel('Body notes').fill('Created from the restored demo Topic filter.');
    await composer.getByRole('button', { name: /start draft/i }).click();

    await expect(signedInPage).toHaveURL(/\/items\//, { timeout: 15_000 });
    await expect(signedInPage.locator('.kp-edit-topic-select select')).toHaveValue(demoTopicName, { timeout: 15_000 });
    await signedInPage.getByLabel('Item save status').getByRole('button', { name: /^save$/i }).click();
    await expect(signedInPage.getByText(/page saved/i)).toBeVisible({ timeout: 15_000 });

    await signedInPage.goto(`/?view=all&topic=${encodeURIComponent(demoTopicSlug)}&q=${encodeURIComponent(createdTitle)}`);
    await expect(cardForTitle(signedInPage, createdTitle)).toBeVisible({ timeout: 15_000 });
    await signedInPage.goto(`/?view=all&topic=${encodeURIComponent(archiveTopicSlug)}&q=${encodeURIComponent(createdTitle)}`);
    await expect(cardForTitle(signedInPage, createdTitle)).toHaveCount(0);
  });
});
