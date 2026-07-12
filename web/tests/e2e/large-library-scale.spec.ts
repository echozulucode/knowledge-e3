import { test, expect, createPageViaApi } from './fixtures.js';

const enabled = process.env['LARGE_LIBRARY_BROWSER'] === '1';
const itemCount = Number.parseInt(process.env['LARGE_LIBRARY_BROWSER_PAGES'] ?? '250', 10);
const marker = `browser-scale-${Date.now()}`;

test.describe('large-library browser performance smoke', () => {
  test.skip(!enabled, 'Opt-in scale gate: run with LARGE_LIBRARY_BROWSER=1 pnpm --filter @echozedlabs/web test:e2e -- large-library-scale.spec.ts');
  test.setTimeout(120_000);

  test('initial browse, topic drawer, search, item open, create/edit stay usable with hundreds of items', async ({ signedInPage, apiAsAdmin }) => {
    let firstSeededItem: { id: string; title: string } | null = null;
    for (let idx = 1; idx <= itemCount; idx += 1) {
      const title = `Browser Scale Item ${marker} ${String(idx).padStart(4, '0')}`;
      const created = await createPageViaApi(apiAsAdmin, {
        title,
        body: buildBody(idx),
        status: idx % 7 === 0 ? 'draft' : 'published',
        tags: ['scale-test', `scale-tag-${idx % 12}`, marker],
        frontmatter: {
          topic: `Scale Topic ${idx % 24}`,
          categories: [`Scale Category ${idx % 8}`],
          groups: [`scale-group-${idx % 10}`],
          summary: `Browser scale item ${idx} for ${marker}.`,
        },
      });
      firstSeededItem ??= { id: created.id, title };
    }

    const browseMs = await timed(async () => {
      await signedInPage.goto('/?view=all');
      await expect(signedInPage.locator('.PageList__Card').first()).toBeVisible({ timeout: 20_000 });
    });

    const topicDrawerMs = await timed(async () => {
      await signedInPage.goto(`/?view=all&q=${marker}`);
      await expect(signedInPage.getByRole('navigation', { name: /topic groups/i })).toBeVisible({ timeout: 20_000 });
      await expect(signedInPage.getByText(/Scale Topic/i).first()).toBeVisible();
    });

    const searchMs = await timed(async () => {
      await signedInPage.goto(`/?view=all&q=${marker}%20retrieval`);
      await expect(signedInPage.getByText(/Browser Scale Item/i).first()).toBeVisible({ timeout: 20_000 });
    });

    const itemOpenMs = await timed(async () => {
      if (!firstSeededItem) throw new Error('No seeded item created for item-open smoke');
      await signedInPage.goto(`/items/${firstSeededItem.id}`);
      await expect(signedInPage).toHaveURL(new RegExp(`/items/${firstSeededItem.id}`), { timeout: 20_000 });
      await expect(signedInPage.getByText(firstSeededItem.title).first()).toBeVisible({ timeout: 20_000 });
      await expect(signedInPage.getByText(marker).first()).toBeVisible({ timeout: 20_000 });
    });

    const createEditMs = await timed(async () => {
      const created = await createPageViaApi(apiAsAdmin, {
        title: `Browser Scale Created ${marker}`,
        body: `Created during browser scale smoke for ${marker}.`,
        tags: ['scale-test', marker],
        frontmatter: { topic: 'Scale Topic Created' },
      });
      await signedInPage.goto(`/items/${created.id}?edit=1`);
      await expect(signedInPage).toHaveURL(/edit/, { timeout: 20_000 });
      await expect(signedInPage.getByLabel('Title')).toHaveValue(/Browser Scale Created/, { timeout: 20_000 });
    });

    expect.soft(browseMs, `initial browse ${browseMs.toFixed(1)}ms`).toBeLessThan(8_000);
    expect.soft(topicDrawerMs, `topic drawer ${topicDrawerMs.toFixed(1)}ms`).toBeLessThan(8_000);
    expect.soft(searchMs, `search ${searchMs.toFixed(1)}ms`).toBeLessThan(8_000);
    expect.soft(itemOpenMs, `item open ${itemOpenMs.toFixed(1)}ms`).toBeLessThan(8_000);
    expect.soft(createEditMs, `create/edit ${createEditMs.toFixed(1)}ms`).toBeLessThan(8_000);
  });
});

function buildBody(idx: number): string {
  return `# Browser Scale Item ${idx}\n\n${marker} retrieval corpus paragraph. ` +
    'This long body verifies that search snippets, card rendering, topic grouping, and item open stay usable with a larger library. '.repeat(12);
}

async function timed(fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}
