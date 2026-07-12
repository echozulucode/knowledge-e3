import { expect, test, createPageViaApi } from './fixtures.js';

const stamp = Date.now();

function cardForTitle(page: import('@playwright/test').Page, title: string) {
  return page.locator('.PageList__Card').filter({ has: page.locator('.PageList__CardTitle', { hasText: title }) });
}

async function scrollspyTopics(page: import('@playwright/test').Page): Promise<string[]> {
  const nav = page.getByRole('navigation', { name: /topic groups/i }).first();
  await expect(nav).toBeVisible({ timeout: 15_000 });
  return nav.locator('.PageList__TopicScrollspyLink span:first-child').evaluateAll((nodes) =>
    nodes.map((node) => node.textContent?.trim() ?? '').filter(Boolean),
  );
}

test.describe('main page search and grouped scrollspy', () => {
  test('search entry filters the main page instead of opening a result picker modal', async ({ signedInPage, apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, {
      title: `Main Search Alpha ${stamp}`,
      body: `needle-main-search-${stamp}`,
      status: 'published',
      frontmatter: { topic: 'Search Alpha Topic' },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `Main Search Beta ${stamp}`,
      body: 'different body text',
      status: 'published',
      frontmatter: { topic: 'Search Beta Topic' },
    });

    await signedInPage.goto('/');
    await expect(signedInPage.getByText('Search pages...')).toHaveCount(0);
    await signedInPage.getByRole('button', { name: /^Search$/ }).click();

    await expect(signedInPage.locator('.kp-palette-modal')).toHaveCount(0);
    const mainSearch = signedInPage.getByLabel('Search items on this page');
    await expect(mainSearch).toBeFocused();

    await mainSearch.fill(`needle-main-search-${stamp}`);
    await expect(signedInPage).toHaveURL((url) => url.pathname === '/' && url.searchParams.get('q') === `needle-main-search-${stamp}`);
    await expect(cardForTitle(signedInPage, `Main Search Alpha ${stamp}`)).toBeVisible();
    await expect(cardForTitle(signedInPage, `Main Search Beta ${stamp}`)).toHaveCount(0);
    await expect(signedInPage.getByRole('link', { name: /Search Alpha Topic 1/i })).toBeVisible();
    await expect(signedInPage.getByRole('link', { name: /Search Beta Topic/i })).toHaveCount(0);
  });

  test('selected topic groups results by primary category in the scrollspy', async ({ signedInPage, apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, {
      title: `Topic Category Runbook ${stamp}`,
      body: `topic-category-marker-${stamp}`,
      status: 'published',
      frontmatter: { topic: 'Scrollspy Topic', categories: ['runbook'] },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `Topic Category Decision ${stamp}`,
      body: `topic-category-marker-${stamp}`,
      status: 'published',
      frontmatter: { topic: 'Scrollspy Topic', categories: ['decision-record'] },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `Other Topic Result ${stamp}`,
      body: `topic-category-marker-${stamp}`,
      status: 'published',
      frontmatter: { topic: 'Other Scrollspy Topic', categories: ['runbook'] },
    });

    await signedInPage.goto(`/?q=topic-category-marker-${stamp}&topic=scrollspy-topic`);

    await expect(signedInPage.getByText(/matching pages across 2 primary categories/i)).toBeVisible();
    await expect(signedInPage.getByRole('navigation', { name: /primary category groups/i })).toBeVisible();
    await expect(signedInPage.getByRole('link', { name: /Runbook 1/i })).toBeVisible();
    await expect(signedInPage.getByRole('link', { name: /Decision record 1/i })).toBeVisible();
    await expect(cardForTitle(signedInPage, `Other Topic Result ${stamp}`)).toHaveCount(0);
  });

  test('topic scrollspy follows title A-Z sort instead of count-first grouping', async ({ signedInPage, apiAsAdmin }) => {
    const marker = `topic-sort-title-${stamp}`;
    await createPageViaApi(apiAsAdmin, {
      title: `Alpha Sort Anchor ${stamp}`,
      body: marker,
      status: 'published',
      frontmatter: { topic: `Alpha Sorted Topic ${stamp}` },
    });
    for (let idx = 1; idx <= 3; idx += 1) {
      await createPageViaApi(apiAsAdmin, {
        title: `Zeta Sort Anchor ${stamp}-${idx}`,
        body: marker,
        status: 'published',
        frontmatter: { topic: `Zebra Sorted Topic ${stamp}` },
      });
    }

    await signedInPage.goto(`/?q=${marker}&sort=title_asc`);

    const topics = await scrollspyTopics(signedInPage);
    expect(topics.slice(0, 2)).toEqual([`Alpha Sorted Topic ${stamp}`, `Zebra Sorted Topic ${stamp}`]);
  });

  test('topic scrollspy follows most-recent item per topic for updated sort', async ({ signedInPage, apiAsAdmin }) => {
    const marker = `topic-sort-updated-${stamp}`;
    for (let idx = 1; idx <= 3; idx += 1) {
      await createPageViaApi(apiAsAdmin, {
        title: `Older Updated Topic Item ${stamp}-${idx}`,
        body: marker,
        status: 'published',
        frontmatter: { topic: `Older Updated Topic ${stamp}` },
      });
    }
    await createPageViaApi(apiAsAdmin, {
      title: `Newest Updated Topic Item ${stamp}`,
      body: marker,
      status: 'published',
      frontmatter: { topic: `Newest Updated Topic ${stamp}` },
    });

    await signedInPage.goto(`/?q=${marker}`);

    const topics = await scrollspyTopics(signedInPage);
    expect(topics.slice(0, 2)).toEqual([`Newest Updated Topic ${stamp}`, `Older Updated Topic ${stamp}`]);
  });

  test('single browse card keeps a readable card width instead of spanning the full result column', async ({ signedInPage, apiAsAdmin }) => {
    const marker = `single-card-width-${stamp}`;
    await createPageViaApi(apiAsAdmin, {
      title: `Single Width Card ${stamp}`,
      body: marker,
      status: 'published',
      frontmatter: { topic: `Single Width Topic ${stamp}` },
    });

    await signedInPage.goto(`/?q=${marker}`);
    const card = cardForTitle(signedInPage, `Single Width Card ${stamp}`);
    await expect(card).toBeVisible();

    const geometry = await card.evaluate((node) => {
      const cardBox = node.getBoundingClientRect();
      const gridBox = node.closest('.PageList__CardGrid')?.getBoundingClientRect();
      return { cardWidth: cardBox.width, gridWidth: gridBox?.width ?? cardBox.width };
    });
    expect(geometry.cardWidth).toBeLessThanOrEqual(520);
    expect(geometry.cardWidth).toBeLessThan(geometry.gridWidth - 24);
  });

  test('active scrollspy entry is scrolled into view in a long primary category list', async ({ signedInPage, apiAsAdmin }) => {
    for (let idx = 1; idx <= 18; idx += 1) {
      await createPageViaApi(apiAsAdmin, {
        title: `Long Scrollspy Category ${stamp}-${idx}`,
        body: `long-scrollspy-marker-${stamp} category ${idx}`,
        status: 'published',
        frontmatter: { topic: 'Long Scrollspy Topic', categories: [`category-${idx.toString().padStart(2, '0')}`] },
      });
    }

    await signedInPage.goto(`/?q=long-scrollspy-marker-${stamp}&topic=long-scrollspy-topic&sort=title_asc`);

    const scrollspyNav = signedInPage.getByRole('navigation', { name: /primary category groups/i });
    await expect(scrollspyNav).toBeVisible();
    await scrollspyNav.evaluate((node) => { node.scrollTop = 0; });

    const groupsScroller = signedInPage.locator('.PageList__TopicGroupsScroller');
    await groupsScroller.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await expect(signedInPage.getByRole('link', { name: /Category 18 1/i })).toHaveClass(/active/, { timeout: 10_000 });

    const activeVisible = await signedInPage.getByRole('link', { name: /Category 18 1/i }).evaluate((link) => {
      const container = link.closest('nav');
      if (!container) return false;
      const linkBox = link.getBoundingClientRect();
      const containerBox = container.getBoundingClientRect();
      return linkBox.top >= containerBox.top - 1 && linkBox.bottom <= containerBox.bottom + 1;
    });
    expect(activeVisible).toBe(true);
  });
});
