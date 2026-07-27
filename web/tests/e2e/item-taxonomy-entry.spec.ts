import { test, expect, createPageViaApi } from './fixtures.js';

async function saveFromSaveBar(page: import('@playwright/test').Page) {
  const saveResponse = page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === 'PUT' && response.url().includes('/api/v1/pages/') && response.ok();
  });
  await page.getByRole('region', { name: /item save status/i }).getByRole('button', { name: /^save/i }).click();
  await saveResponse;
  await expect(page.getByRole('region', { name: /item save status/i })).toContainText(/saved/i, { timeout: 15_000 });
}

test.describe('item editor taxonomy controls', () => {
  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('does not render taxonomy pickers and preserves existing taxonomy frontmatter on save @quarantine', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Immutable Taxonomy Target',
      body: 'Existing taxonomy should not be visually editable from the article editor.',
      status: 'draft',
      frontmatter: {
        space: 'Research Lab',
        categories: ['architecture', 'design'],
        tags: ['ai', 'capture-flow'],
        groups: ['roadmap', 'mcp'],
      },
    });

    await signedInPage.goto(`/p/${p.slug}?edit=1`);

    await expect(signedInPage.getByRole('combobox', { name: /space|topic/i })).toHaveCount(0);
    await expect(signedInPage.getByRole('combobox', { name: /primary category/i })).toHaveCount(0);
    await expect(signedInPage.getByRole('textbox', { name: /additional categories/i })).toHaveCount(0);
    await expect(signedInPage.getByRole('textbox', { name: /^tags$/i })).toHaveCount(0);
    await expect(signedInPage.getByRole('textbox', { name: /^groups$/i })).toHaveCount(0);
    await expect(signedInPage.getByRole('region', { name: /taxonomy pickers/i })).toHaveCount(0);

    const title = signedInPage.getByRole('textbox', { name: 'Title', exact: true });
    await title.fill('Immutable Taxonomy Target Renamed');
    await saveFromSaveBar(signedInPage);

    const refreshed = await apiAsAdmin.get(`/api/v1/pages/${p.id}`);
    expect(refreshed.ok()).toBeTruthy();
    const { page } = await refreshed.json();
    expect(page.title).toBe('Immutable Taxonomy Target Renamed');
    expect(page.frontmatter.space).toBe('Research Lab');
    expect(page.frontmatter.categories).toEqual(['architecture', 'design']);
    expect(page.frontmatter.tags).toEqual(['ai', 'capture-flow']);
    expect(page.frontmatter.groups).toEqual(['roadmap', 'mcp']);
    expect(page.categories).toEqual(['architecture', 'design']);
    expect(page.tags).toEqual(['ai', 'capture-flow']);
    expect(page.groups).toEqual(['mcp', 'roadmap']);
  });
});
