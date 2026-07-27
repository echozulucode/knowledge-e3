import { test, expect, createPageViaApi } from './fixtures.js';

function cardForTitle(page: import('@playwright/test').Page, title: string) {
  return page.locator('.PageList__Card').filter({ has: page.locator('.PageList__CardTitle', { hasText: title }) });
}

test.describe('search and browse cards', () => {
  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('browse renders responsive item cards with summary, metadata chips, color band, and no delete action @quarantine', async ({ signedInPage, apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, {
      title: 'Card Metadata Showcase',
      status: 'published',
      body: '# Card Metadata Showcase\n\n## Overview\n\nThis fallback overview should lose to frontmatter summary.',
      tags: ['mvp', 'browse'],
      frontmatter: {
        summary: 'Frontmatter summary wins for the browse card preview.',
        categories: ['Architecture'],
        groups: ['Editor Experience'],
      },
    });

    await signedInPage.setViewportSize({ width: 1280, height: 900 });
    await signedInPage.goto('/browse');

    const card = cardForTitle(signedInPage, 'Card Metadata Showcase');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator('.PageList__BriefPreview')).toContainText('Frontmatter summary wins for the browse card preview.');
    await expect(card.getByText('Architecture', { exact: true })).toBeVisible();
    await expect(card.getByText('editor-experience', { exact: true })).toBeVisible();
    await expect(card.getByText('#mvp', { exact: true })).toBeVisible();
    await expect(card.getByText(/Published/i)).toBeVisible();
    await expect(card.getByText(/Default space/i)).toBeVisible();

    const categoryColor = await card.evaluate((el) => getComputedStyle(el).getPropertyValue('--PageList-category-color').trim());
    expect(categoryColor).toMatch(/^hsl\(/);

    await expect(signedInPage.getByRole('button', { name: /delete/i })).toHaveCount(0);

    const desktopBox = await card.boundingBox();
    expect(desktopBox?.width ?? 0).toBeGreaterThan(300);

    await signedInPage.setViewportSize({ width: 390, height: 800 });
    const mobileBox = await card.boundingBox();
    expect(mobileBox?.width ?? 0).toBeGreaterThan(300);
    expect(mobileBox?.width ?? 999).toBeLessThanOrEqual(390);
  });

  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('card click opens read view and hover/focus edit pencil opens edit mode @quarantine', async ({ signedInPage, apiAsAdmin }) => {
    const item = await createPageViaApi(apiAsAdmin, {
      title: 'Clickable Browse Card',
      status: 'published',
      body: 'Readable browse card body.',
      tags: ['navigation'],
      frontmatter: { categories: ['UX'] },
    });

    await signedInPage.goto('/browse');
    const card = cardForTitle(signedInPage, 'Clickable Browse Card');
    await expect(card).toBeVisible({ timeout: 15_000 });

    const editButton = card.getByRole('button', { name: /edit clickable browse card/i });
    await card.hover();
    await expect(editButton).toBeVisible();
    await expect.poll(
      async () => editButton.evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity)),
      { timeout: 2_000 },
    ).toBeGreaterThan(0.9);

    await editButton.click();
    await expect(signedInPage).toHaveURL((url) => url.pathname === `/p/${item.slug}` && url.searchParams.has('edit'), {
      timeout: 10_000,
    });

    await signedInPage.goto('/browse');
    const focusedCard = cardForTitle(signedInPage, 'Clickable Browse Card');
    await focusedCard.focus();
    await focusedCard.hover();
    const focusedEdit = focusedCard.getByRole('button', { name: /edit clickable browse card/i });
    await expect(focusedEdit).toBeVisible();
    await expect.poll(
      async () => focusedEdit.evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity)),
      { timeout: 2_000 },
    ).toBeGreaterThan(0.9);

    await focusedCard.click({ position: { x: 24, y: 72 } });
    await expect(signedInPage).toHaveURL((url) => url.pathname === `/p/${item.slug}` && !url.searchParams.has('edit'), {
      timeout: 10_000,
    });
    await expect(signedInPage.getByText('Readable browse card body.')).toBeVisible({ timeout: 15_000 });
  });

  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('one-command cards expose copy without triggering card navigation @quarantine', async ({ signedInPage, apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, {
      title: 'Copy Command Card',
      status: 'draft',
      body: 'pnpm --filter @echozedlabs/web typecheck',
      frontmatter: { categories: ['Runbook'] },
    });

    await signedInPage.goto('/browse');
    await signedInPage.evaluate(() => {
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

    const card = cardForTitle(signedInPage, 'Copy Command Card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator('.PageList__CommandPreview code')).toHaveText('pnpm --filter @echozedlabs/web typecheck');

    await card.getByRole('button', { name: /copy command from copy command card/i }).click();
    await expect(signedInPage).toHaveURL(/\/$/);
    const copied = await signedInPage.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe('pnpm --filter @echozedlabs/web typecheck');
  });

  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('empty search offers create item seeded with query and selected taxonomy context @quarantine', async ({ signedInPage }) => {
    await signedInPage.goto('/?view=all&q=Autonomous+Research+Plan&topic=Research%20topic&category=Decision%20record&tag=agentic-ai&group=roadmap');

    await expect(signedInPage.getByRole('heading', { name: /no matches found/i })).toBeVisible({ timeout: 15_000 });
    await signedInPage.getByRole('button', { name: /create item from search/i }).click();

    await expect(signedInPage.getByRole('dialog', { name: /new item composer/i })).toBeVisible();
    await expect(signedInPage.getByLabel('Title')).toHaveValue('Autonomous Research Plan');
    await expect(signedInPage.getByLabel('Topic')).toHaveValue('Research topic');
    await expect(signedInPage.getByLabel('Primary category')).toHaveValue('Decision record');
    await expect(signedInPage.getByText('#agentic-ai')).toBeVisible();
    await expect(signedInPage.getByLabel('Groups')).toHaveValue('roadmap');
  });

  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('search cards explain title, body, tag, category, and group matches @quarantine', async ({ signedInPage, apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, {
      title: 'Trustworthy Search Card',
      status: 'published',
      body: '# Trustworthy Search Card\n\nRotation notes mention credentials and escalation paths.',
      tags: ['security'],
      frontmatter: {
        categories: ['Runbook'],
        groups: ['Incident Command'],
      },
    });

    await signedInPage.goto('/?view=all&q=credentials');
    const bodyCard = cardForTitle(signedInPage, 'Trustworthy Search Card');
    await expect(bodyCard).toBeVisible({ timeout: 15_000 });
    await expect(bodyCard.getByText('Body match', { exact: true })).toBeVisible();

    await signedInPage.goto('/?view=all&q=security');
    const tagCard = cardForTitle(signedInPage, 'Trustworthy Search Card');
    await expect(tagCard).toBeVisible({ timeout: 15_000 });
    await expect(tagCard.getByText('Tag: security', { exact: true })).toBeVisible();

    await signedInPage.goto('/?view=all&q=Runbook');
    const categoryCard = cardForTitle(signedInPage, 'Trustworthy Search Card');
    await expect(categoryCard).toBeVisible({ timeout: 15_000 });
    await expect(categoryCard.getByText('Category: Runbook', { exact: true })).toBeVisible();

    await signedInPage.goto('/?view=all&q=Incident');
    const groupCard = cardForTitle(signedInPage, 'Trustworthy Search Card');
    await expect(groupCard).toBeVisible({ timeout: 15_000 });
    await expect(groupCard.getByText('Group: incident-command', { exact: true })).toBeVisible();
  });
});
