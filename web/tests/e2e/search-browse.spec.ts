import { test, expect, createPageViaApi, ensureCategories } from './fixtures.js';

function cardForTitle(page: import('@playwright/test').Page, title: string) {
  return page.locator('.PageList__Card').filter({ has: page.locator('.PageList__CardTitle', { hasText: title }) });
}

test.describe('search and browse cards', () => {
  test('browse renders responsive item cards with summary, metadata chips, color band, and no delete action', async ({ signedInPage, apiAsAdmin }) => {
    await ensureCategories(apiAsAdmin, 'Architecture');
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
    // The footer names the item's space and its last update; which space depends
    // on the seeded corpus, so assert the shape rather than one corpus's default.
    await expect(card.locator('.PageList__CardFooter')).toContainText(/Updated/i);

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

  test('card click opens read view and the hover/focus edit pencil opens Compose', async ({ signedInPage, apiAsAdmin }) => {
    await ensureCategories(apiAsAdmin, 'UX');
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
    // The pencil opens Compose (plan §4.1); `?edit=1` only survives as a redirect.
    await expect(signedInPage).toHaveURL((url) => url.pathname === `/p/${item.slug}/edit`, {
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

    await focusedCard.getByRole('button', { name: /open clickable browse card/i }).focus();
    await signedInPage.keyboard.press('Enter');
    await expect(signedInPage).toHaveURL((url) => url.pathname === `/p/${item.slug}`, {
      timeout: 10_000,
    });
    await expect(signedInPage.getByText('Readable browse card body.')).toBeVisible({ timeout: 15_000 });
  });

  /**
   * A search that found nothing is the best moment to write the missing item,
   * and the wording the reader already typed is the best title for it. That
   * capability did not go with the modal composer — it moved: browse now hands
   * the query and the active facets to Compose as `/new?title=…&tag=…`.
   */
  test('empty search offers create item seeded with the query and the selected taxonomy context', async ({ signedInPage }) => {
    await signedInPage.goto('/browse?q=Autonomous+Research+Plan&category=decision-record&tag=agentic-ai&group=roadmap');

    await expect(signedInPage.getByRole('heading', { name: /no matches found/i })).toBeVisible({ timeout: 15_000 });
    await signedInPage.getByRole('button', { name: /create item from search/i }).click();

    await expect(signedInPage).toHaveURL((url) => url.pathname === '/new', { timeout: 15_000 });
    await expect(signedInPage.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Autonomous Research Plan', {
      timeout: 15_000,
    });

    // The facets that were narrowing the search become the draft's metadata,
    // which the Publish drawer is where an author confirms.
    await signedInPage.getByRole('region', { name: /item save status/i }).getByRole('button', { name: /publish/i }).click();
    const drawer = signedInPage.getByRole('dialog', { name: /^publish$/i });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel('Primary category')).toHaveValue('decision-record');
    await expect(drawer.getByText('agentic-ai').first()).toBeVisible();
    await expect(drawer.getByText('roadmap').first()).toBeVisible();
  });

  test('search cards explain title, body, tag, category, and group matches', async ({ signedInPage, apiAsAdmin }) => {
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

    await signedInPage.goto('/browse?q=credentials');
    const bodyCard = cardForTitle(signedInPage, 'Trustworthy Search Card');
    await expect(bodyCard).toBeVisible({ timeout: 15_000 });
    await expect(bodyCard.getByText('Body match', { exact: true })).toBeVisible();

    await signedInPage.goto('/browse?q=security');
    const tagCard = cardForTitle(signedInPage, 'Trustworthy Search Card');
    await expect(tagCard).toBeVisible({ timeout: 15_000 });
    await expect(tagCard.getByText('Tag: security', { exact: true })).toBeVisible();

    await signedInPage.goto('/browse?q=Runbook');
    const categoryCard = cardForTitle(signedInPage, 'Trustworthy Search Card');
    await expect(categoryCard).toBeVisible({ timeout: 15_000 });
    await expect(categoryCard.getByText('Category: Runbook', { exact: true })).toBeVisible();

    await signedInPage.goto('/browse?q=Incident');
    const groupCard = cardForTitle(signedInPage, 'Trustworthy Search Card');
    await expect(groupCard).toBeVisible({ timeout: 15_000 });
    await expect(groupCard.getByText('Group: incident-command', { exact: true })).toBeVisible();
  });
});
