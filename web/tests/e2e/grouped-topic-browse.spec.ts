import { expect, test, createPageViaApi } from './fixtures.js';

const stamp = Date.now();

test.describe('grouped topic browse view', () => {
  test('groups filtered cards by topic, each group stating how much of itself is shown', async ({ signedInPage, apiAsAdmin }) => {
    for (let idx = 1; idx <= 8; idx += 1) {
      await createPageViaApi(apiAsAdmin, {
        title: `Grouped Research ${stamp}-${idx}`,
        body: `Shared grouped browse marker ${stamp} research ${idx}`,
        status: idx % 2 === 0 ? 'published' : 'draft',
        tags: ['grouped-browse'],
        frontmatter: { topic: 'Research' },
      });
    }
    for (let idx = 1; idx <= 2; idx += 1) {
      await createPageViaApi(apiAsAdmin, {
        title: `Grouped Implementation ${stamp}-${idx}`,
        body: `Shared grouped browse marker ${stamp} implementation ${idx}`,
        tags: ['grouped-browse'],
        frontmatter: { topic: 'Implementation' },
      });
    }

    await signedInPage.goto(`/browse?view=grouped&q=${stamp}`);

    await expect(signedInPage.getByRole('heading', { name: /grouped by topic/i })).toHaveCount(0);
    await expect(signedInPage.getByRole('button', { name: /^All$/ })).toHaveCount(0);
    await expect(signedInPage.getByRole('button', { name: /^Draft$/ })).toHaveCount(0);
    await expect(signedInPage.getByRole('button', { name: /^Published$/ })).toHaveCount(0);
    await expect(signedInPage.getByRole('navigation', { name: /^topics$/i })).toBeVisible();
    await expect(signedInPage.getByRole('link', { name: /Research 8/i })).toBeVisible();
    await expect(signedInPage.getByRole('link', { name: /Implementation 2/i })).toBeVisible();

    const topicScrollspy = signedInPage.getByRole('navigation', { name: /^topics$/i });
    const groupsScroller = signedInPage.locator('.PageList__TopicGroupsScroller');
    await expect(groupsScroller).toBeVisible();
    await expect(groupsScroller).toHaveCSS('overflow-y', /auto|scroll/);
    const scrollspyTopBefore = await topicScrollspy.boundingBox();
    await groupsScroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const scrollspyTopAfter = await topicScrollspy.boundingBox();
    expect(Math.abs((scrollspyTopBefore?.top ?? 0) - (scrollspyTopAfter?.top ?? 0))).toBeLessThan(2);

    // Each group says how much of itself is on screen and how large it is. The
    // 2026-09 grouped layout replaced the six-card preview and its "See all"
    // button with an infinite-scroll window, so the count line IS the promise —
    // the reader is never shown a partial group without being told so.
    const researchGroup = signedInPage.getByRole('region', { name: /Research topic group/i });
    await expect(researchGroup).toContainText('Showing 8 of 8 items by current sort.');
    await expect(researchGroup.locator('.PageList__TopicGroupCount')).toHaveText('8 items');
    await expect(researchGroup.locator('.PageList__Card')).toHaveCount(8);

    // And the scrollspy is the way to the group, carrying the same count.
    await signedInPage.getByRole('link', { name: /Research 8/i }).click();
    await expect(researchGroup).toBeVisible();
    await expect(signedInPage.getByText(`Grouped Research ${stamp}-7`)).toBeVisible();
  });
});
