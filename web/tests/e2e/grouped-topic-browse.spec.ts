import { expect, test, createPageViaApi } from './fixtures.js';

const stamp = Date.now();

test.describe('grouped topic browse view', () => {
  test('groups filtered cards by topic with a capped preview and see-more topic links', async ({ signedInPage, apiAsAdmin }) => {
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

    await signedInPage.goto(`/?q=${stamp}`);

    await expect(signedInPage.getByRole('heading', { name: /grouped by topic/i })).toHaveCount(0);
    await expect(signedInPage.getByRole('button', { name: /^All$/ })).toHaveCount(0);
    await expect(signedInPage.getByRole('button', { name: /^Draft$/ })).toHaveCount(0);
    await expect(signedInPage.getByRole('button', { name: /^Published$/ })).toHaveCount(0);
    await expect(signedInPage.getByRole('navigation', { name: /topic groups/i })).toBeVisible();
    await expect(signedInPage.getByRole('link', { name: /Research 8/i })).toBeVisible();
    await expect(signedInPage.getByRole('link', { name: /Implementation 2/i })).toBeVisible();

    const topicScrollspy = signedInPage.getByRole('navigation', { name: /topic groups/i });
    const groupsScroller = signedInPage.locator('.PageList__TopicGroupsScroller');
    await expect(groupsScroller).toBeVisible();
    await expect(groupsScroller).toHaveCSS('overflow-y', /auto|scroll/);
    const scrollspyTopBefore = await topicScrollspy.boundingBox();
    await groupsScroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const scrollspyTopAfter = await topicScrollspy.boundingBox();
    expect(Math.abs((scrollspyTopBefore?.top ?? 0) - (scrollspyTopAfter?.top ?? 0))).toBeLessThan(2);

    const researchGroup = signedInPage.getByRole('region', { name: /Research topic group/i });
    await expect(researchGroup).toContainText('Showing 6 of 8 items');
    await expect(researchGroup.locator('.PageList__Card')).toHaveCount(6);

    await researchGroup.getByRole('button', { name: /See all 8 Research items/i }).click();
    await expect(signedInPage).toHaveURL(/topic=research/);
    await expect(signedInPage.getByText(`Grouped Research ${stamp}-7`)).toBeVisible();
  });
});
