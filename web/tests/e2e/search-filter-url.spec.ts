import { test, expect, createPageViaApi } from './fixtures.js';

function cardForTitle(page: import('@playwright/test').Page, title: string) {
  return page.locator('.PageList__Card').filter({ has: page.locator('.PageList__CardTitle', { hasText: title }) });
}

test.describe('browse filter URLs', () => {
  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('restores query, metadata filters, status, and sort after opening an item and going back @quarantine', async ({ signedInPage, apiAsAdmin }) => {
    const matching = await createPageViaApi(apiAsAdmin, {
      title: 'URL Filter Alpha',
      status: 'published',
      body: '# URL Filter Alpha\n\nA URL restore candidate.',
      tags: ['url-state'],
      frontmatter: {
        summary: 'This item should survive every browse URL filter.',
        categories: ['decision-record'],
        groups: ['editor-experience'],
        space: 'Research workspace',
      },
    });

    await createPageViaApi(apiAsAdmin, {
      title: 'URL Filter Beta',
      status: 'draft',
      body: '# URL Filter Beta\n\nSame search text, wrong metadata.',
      tags: ['url-state'],
      frontmatter: {
        categories: ['implementation-notes'],
        groups: ['data-entry'],
        space: 'Product workspace',
      },
    });

    await signedInPage.goto('/browse?view=grouped&q=URL%20Filter&status=published&space=Research%20workspace&category=decision-record&tag=url-state&group=editor-experience&sort=title_asc');

    await expect(signedInPage.getByLabel('Active browse filters')).toContainText('Search: URL Filter');
    await expect(signedInPage.getByLabel('Active browse filters')).toContainText('Topic: Research workspace');
    await expect(signedInPage.getByLabel('Active browse filters')).toContainText('Category: decision-record');
    await expect(signedInPage.getByLabel('Active browse filters')).toContainText('Tag: url-state');
    await expect(signedInPage.getByLabel('Active browse filters')).toContainText('Group: editor-experience');
    await expect(signedInPage.getByLabel('Active browse filters')).toContainText('Status: published');
    await expect(signedInPage.getByLabel('Active browse filters')).toContainText('Sort: Title A-Z');

    await expect(cardForTitle(signedInPage, 'URL Filter Alpha')).toBeVisible({ timeout: 15_000 });
    await expect(cardForTitle(signedInPage, 'URL Filter Beta')).toHaveCount(0);

    await cardForTitle(signedInPage, 'URL Filter Alpha').click({ position: { x: 24, y: 72 } });
    await expect(signedInPage).toHaveURL((url) => url.pathname === `/p/${matching.slug}`, { timeout: 10_000 });

    await signedInPage.goBack();
    await expect(signedInPage).toHaveURL((url) => {
      return url.pathname === '/browse'
        && url.searchParams.get('q') === 'URL Filter'
        && url.searchParams.get('status') === 'published'
        && url.searchParams.get('space') === 'Research workspace'
        && url.searchParams.get('category') === 'decision-record'
        && url.searchParams.get('tag') === 'url-state'
        && url.searchParams.get('group') === 'editor-experience'
        && url.searchParams.get('sort') === 'title_asc';
    });
    await expect(cardForTitle(signedInPage, 'URL Filter Alpha')).toBeVisible();
    await expect(signedInPage.getByLabel('Active browse filters')).toContainText('Search: URL Filter');
  });

  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('clear filters returns to all-items browse and malformed params do not blank the page @quarantine', async ({ signedInPage, apiAsAdmin }) => {
    await createPageViaApi(apiAsAdmin, {
      title: 'Clear Filter Target',
      status: 'published',
      body: 'Visible after filters are cleared.',
      tags: ['clearable'],
      frontmatter: { categories: ['runbook'], groups: ['ops'], space: 'Default space' },
    });

    await signedInPage.goto('/browse?view=grouped&tag=clearable&status=published&sort=created_desc');
    await expect(cardForTitle(signedInPage, 'Clear Filter Target')).toBeVisible({ timeout: 15_000 });
    await signedInPage.getByRole('button', { name: /clear filters/i }).click();

    await expect(signedInPage).toHaveURL((url) => url.pathname === '/browse' && url.searchParams.get('view') === 'grouped' && !url.searchParams.has('tag') && !url.searchParams.has('status'));
    await expect(signedInPage.getByRole('heading', { name: 'Grouped by space' })).toBeVisible();
    await expect(cardForTitle(signedInPage, 'Clear Filter Target')).toBeVisible();

    // Malformed params must fall back rather than blank the page: `view` falls
    // back to the default view, whose heading is 'Library'.
    await signedInPage.goto('/browse?view=not-a-view&status=archived&sort=sideways&space=unknown-space');
    await expect(signedInPage.getByRole('heading', { name: 'Library' })).toBeVisible({ timeout: 15_000 });
    await expect(signedInPage.locator('.PageList')).toBeVisible();
  });
});
