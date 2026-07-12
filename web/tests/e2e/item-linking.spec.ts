import { test, expect, createPageViaApi } from './fixtures.js';

test.describe('item editor link suggestions and backlinks', () => {
  test('item editor omits redundant Search pages control while backlinks still index id-backed Markdown links', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    const suffix = `round-trip-${testInfo.workerIndex}-${Date.now()}`;
    const targetTitle = `Round Trip Hub ${suffix}`;
    const sourceTitle = `Round Trip Source ${suffix}`;
    const renamedTitle = `Round Trip Hub Renamed ${suffix}`;
    const target = await createPageViaApi(apiAsAdmin, {
      title: targetTitle,
      body: 'A target page discoverable by body text and tag.',
      status: 'published',
      tags: ['roundtrip-tag'],
    });
    const source = await createPageViaApi(apiAsAdmin, {
      title: sourceTitle,
      body: 'Start here.',
      status: 'published',
    });

    await signedInPage.goto(`/p/${source.slug}?edit=1`);
    await expect(signedInPage.getByRole('searchbox', { name: 'Search pages' })).toHaveCount(0);

    const sourceWithLink = await apiAsAdmin.put(`/api/v1/pages/${source.id}`, {
      headers: { 'If-Match': String(source.version_token) },
      data: {
        title: sourceTitle,
        body: `Start here.\n\n[${targetTitle}](<${target.id}>)`,
        frontmatter: { status: 'published' },
      },
    });
    expect(sourceWithLink.ok()).toBeTruthy();

    const savedSource = await (await apiAsAdmin.get(`/api/v1/pages/${source.id}`)).json();
    expect(savedSource.page.body_markdown).toContain(`[${targetTitle}](<${target.id}>)`);

    const initialBacklinks = await (await apiAsAdmin.get(`/api/v1/pages/${target.id}/backlinks`)).json();
    expect(initialBacklinks.backlinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_title: sourceTitle,
          link_type: 'markdown',
          target_ref: target.id,
        }),
      ]),
    );

    const renamed = await apiAsAdmin.post(`/api/v1/pages/${target.id}/rename`, {
      headers: { 'If-Match': String(target.version_token) },
      data: { new_title: renamedTitle, link_action: 'skip' },
    });
    expect(renamed.ok()).toBeTruthy();

    await signedInPage.goto(`/items/${target.id}`);
    await expect(signedInPage.getByText(renamedTitle)).toBeVisible();
    await signedInPage.getByRole('button', { name: /Backlinks \(1\)/ }).click();
    const backlinkCard = signedInPage.getByRole('link', { name: new RegExp(sourceTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
    await expect(backlinkCard).toBeVisible();
    await expect(backlinkCard).toContainText(targetTitle);
  });
});
