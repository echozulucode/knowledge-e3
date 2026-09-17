import { test, expect, createPageViaApi } from './fixtures.js';

/**
 * Series (features/12-latest-feed.feature; home plan R2.11 and R2.4).
 *
 * The fixture is created through the API rather than read from seed content:
 * a Series item, and three parts created OUT of reading order so the page can
 * only pass by honouring `series_order`.
 */
test.describe('series', () => {
  test('the series page is headed by the Series item and lists its parts in series_order; a part navigates the series', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const seriesTitle = `Onboarding Journey ${suffix}`;
    const landing = await createPageViaApi(apiAsAdmin, {
      title: seriesTitle,
      body: '## About this series\n\nThree steps.\n\n## Parts\n\n- written by hand, deliberately in the wrong order',
      status: 'published',
      frontmatter: { type: 'Series', description: `Everything you need on day one ${suffix}.` },
    });
    const series = landing.slug;
    const partTitle = (n: number) => `Journey Part ${n} ${suffix}`;
    const part3 = await createPageViaApi(apiAsAdmin, {
      title: partTitle(3),
      body: 'The third step.',
      status: 'published',
      frontmatter: { type: 'Blog Post', series, series_order: 3, published_at: '2026-03-01T00:00:00.000Z' },
    });
    const part1 = await createPageViaApi(apiAsAdmin, {
      title: partTitle(1),
      body: 'The first step.',
      status: 'published',
      frontmatter: { type: 'Blog Post', series, series_order: 1, published_at: '2026-03-03T00:00:00.000Z' },
    });
    const part2 = await createPageViaApi(apiAsAdmin, {
      title: partTitle(2),
      body: 'The second step.',
      status: 'published',
      frontmatter: { type: 'Blog Post', series, series_order: 2, published_at: '2026-03-02T00:00:00.000Z', description: 'Step two' },
    });

    // The series page: the Series item's title, not the slug.
    await signedInPage.goto(`/series/${series}`);
    await expect(signedInPage.getByRole('heading', { level: 1, name: seriesTitle })).toBeVisible();
    await expect(signedInPage.getByText(`Everything you need on day one ${suffix}.`)).toBeVisible();
    await expect(signedInPage.getByTestId('series-summary')).toContainText('3 parts');
    const parts = signedInPage.getByTestId('series-part');
    await expect(parts).toHaveCount(3);
    await expect(parts.nth(0)).toContainText(partTitle(1));
    await expect(parts.nth(1)).toContainText(partTitle(2));
    await expect(parts.nth(1)).toContainText('Step two');
    await expect(parts.nth(2)).toContainText(partTitle(3));
    await expect(parts.nth(0).getByRole('link', { name: partTitle(1) })).toHaveAttribute('href', `/p/${part1.slug}`);

    // Part 2's article says where it sits, and the byline states the trust tier.
    await parts.nth(1).getByRole('link', { name: partTitle(2) }).click();
    await expect(signedInPage).toHaveURL(new RegExp(`/p/${part2.slug}$`));
    const box = signedInPage.getByTestId('series-box');
    await expect(box).toContainText(`Part 2 of 3 in ${seriesTitle}`);
    await expect(signedInPage.getByText(`Series: ${series}`)).toHaveCount(0);
    await expect(signedInPage.locator('.kp-article-header__meta .kp-trust-inline')).toContainText('Unverified');

    // The disclosure lists every part, with this one marked.
    const partsList = box.getByRole('list');
    await expect(partsList).toBeHidden();
    await box.getByRole('button', { name: 'Show all parts' }).click();
    await expect(partsList.getByRole('listitem')).toHaveCount(3);
    await expect(partsList.locator('[aria-current="page"]')).toHaveText(partTitle(2));

    // The series title links back to the series page.
    await expect(box.getByRole('link', { name: seriesTitle })).toHaveAttribute('href', `/series/${series}`);

    // Previous and next, by title, and they work.
    const pager = signedInPage.getByTestId('series-pager');
    await pager.getByRole('link', { name: new RegExp(`Next.*${partTitle(3)}`) }).click();
    await expect(signedInPage).toHaveURL(new RegExp(`/p/${part3.slug}$`));
    await expect(signedInPage.getByTestId('series-box')).toContainText(`Part 3 of 3 in ${seriesTitle}`);
    await expect(signedInPage.getByTestId('series-pager').getByRole('link', { name: /Next/ })).toHaveCount(0);

    await signedInPage.getByTestId('series-pager').getByRole('link', { name: new RegExp(`Previous.*${partTitle(2)}`) }).click();
    await expect(signedInPage).toHaveURL(new RegExp(`/p/${part2.slug}$`));
    await signedInPage.getByTestId('series-pager').getByRole('link', { name: new RegExp(`Previous.*${partTitle(1)}`) }).click();
    await expect(signedInPage).toHaveURL(new RegExp(`/p/${part1.slug}$`));
    await expect(signedInPage.getByTestId('series-box')).toContainText(`Part 1 of 3 in ${seriesTitle}`);
  });

  test('without a Series item the heading is the humanised slug, and a lone part shows no series navigation', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const series = `solo-notes-${suffix}`;
    const only = await createPageViaApi(apiAsAdmin, {
      title: `Solo Note ${suffix}`,
      body: 'The only part so far.',
      status: 'published',
      frontmatter: { type: 'Blog Post', series, series_order: 1 },
    });

    await signedInPage.goto(`/series/${series}`);
    await expect(signedInPage.getByRole('heading', { level: 1, name: `Solo notes ${suffix.replace(/-/g, ' ')}` })).toBeVisible();
    await expect(signedInPage.getByTestId('series-part')).toHaveCount(1);

    await signedInPage.goto(`/p/${only.slug}`);
    await expect(signedInPage.getByRole('heading', { level: 1, name: `Solo Note ${suffix}` })).toBeVisible();
    await expect(signedInPage.locator('.kp-article-header__meta .kp-trust-inline')).toContainText('Unverified');
    await expect(signedInPage.getByTestId('series-box')).toHaveCount(0);
    await expect(signedInPage.getByTestId('series-pager')).toHaveCount(0);
  });
});
