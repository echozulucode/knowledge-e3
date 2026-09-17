import { test, expect, createPageViaApi } from './fixtures.js';

test.describe('item editor link suggestions and backlinks', () => {
  test('backlinks index id-backed Markdown links and survive a rename', async ({
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

    // The original assertion here was that the editor carries NO page search.
    // Compose reverses that on purpose: the host toolbar's link search is how an
    // author inserts an id-backed link in the first place, which is what the rest
    // of this test then follows through the backlink index.
    await signedInPage.goto(`/p/${source.slug}/edit`);
    await expect(signedInPage.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(sourceTitle, {
      timeout: 15_000,
    });
    await expect(signedInPage.getByRole('searchbox', { name: 'Search pages' })).toBeVisible();

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
    // What links here now reads as Related at the end of the article rather
    // than as a collapsed panel under the rail's Tags tab (plan §6, R4.7).
    const related = signedInPage.getByRole('region', { name: 'Related' });
    await expect(related.getByRole('link', { name: sourceTitle })).toBeVisible();
    await expect(related).toContainText(targetTitle);
  });
});
