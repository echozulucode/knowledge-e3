import playwright from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { test, expect, createPageViaApi, createUserApiContext } from './fixtures.js';

/**
 * A topic page's Updates and Popular band (features/11-topic-landing.feature,
 * home plan R3): the topic's items carrying the site's Updates tags, newest
 * first and only from this topic; "Recently updated" when nothing is tagged; and
 * "Popular in <topic>" once at least three items have distinct readers.
 *
 * The Updates rule is read from the cross-topic Section the front page leads
 * with, so the first test installs its own (lowest `order`, unique tag) and puts
 * the catalog back afterwards rather than depending on whatever the seed or an
 * earlier spec left there.
 */

async function getSections(api: APIRequestContext): Promise<Record<string, unknown>[]> {
  const res = await api.get('/api/v1/sections');
  if (!res.ok()) throw new Error(`list sections failed: ${res.status()}`);
  return ((await res.json()).sections ?? []) as Record<string, unknown>[];
}

async function putSections(api: APIRequestContext, sections: Record<string, unknown>[]) {
  const res = await api.put('/api/v1/sections', { data: { sections } });
  if (!res.ok()) throw new Error(`save sections failed: ${res.status()} ${await res.text()}`);
}

async function createTopic(api: APIRequestContext, data: Record<string, unknown>) {
  const res = await api.post('/api/v1/topics', { data });
  if (!res.ok()) throw new Error(`seed topic failed: ${res.status()} ${await res.text()}`);
}

async function recordView(api: APIRequestContext, pageId: string) {
  const res = await api.post('/api/v1/events/page-view', { data: { page_id: pageId } });
  if (res.status() !== 204) throw new Error(`page-view failed: ${res.status()} ${await res.text()}`);
}

test.describe('topic page updates and popular', () => {
  test('Updates lists this topic’s tagged items newest first, and no other topic’s', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const slug = `tu-${suffix}`;
    const name = `Updates Topic ${suffix}`;
    const tag = `tu-update-${suffix}`;
    await createTopic(apiAsAdmin, { name, slug, presentation: 'wiki' });
    await createTopic(apiAsAdmin, { name: `Other Topic ${suffix}`, slug: `tu-other-${suffix}` });

    await createPageViaApi(apiAsAdmin, {
      title: `TU Older ${suffix}`,
      body: 'Older update.',
      status: 'published',
      tags: [tag],
      // A Concept on purpose: the block mirrors a Section, which names no type.
      frontmatter: { type: 'Concept', topic: slug, description: `Older brief ${suffix}`, published_at: '2026-02-01T12:00:00.000Z' },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `TU Newer ${suffix}`,
      body: 'Newer update.',
      status: 'published',
      tags: [tag],
      frontmatter: { type: 'Blog Post', topic: slug, description: `Newer brief ${suffix}`, published_at: '2026-03-01T12:00:00.000Z' },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `TU Untagged ${suffix}`,
      body: 'Not an update.',
      status: 'published',
      frontmatter: { type: 'Blog Post', topic: slug, published_at: '2026-04-01T12:00:00.000Z' },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `TU Elsewhere ${suffix}`,
      body: 'Another topic’s update.',
      status: 'published',
      tags: [tag],
      frontmatter: { type: 'Blog Post', topic: `tu-other-${suffix}`, published_at: '2026-05-01T12:00:00.000Z' },
    });

    const saved = await getSections(apiAsAdmin);
    await putSections(apiAsAdmin, [
      ...saved,
      { name: `TU Section ${suffix}`, slug: `tu-section-${suffix}`, tags: [tag], order: -1000, limit: 12 },
    ]);
    try {
      await signedInPage.goto(`/topics/${slug}`);
      const block = signedInPage.getByTestId('topic-updates');
      await expect(block).toHaveAttribute('data-variant', 'tagged');
      // The heading is the Section's own name, as on the front page.
      await expect(block.getByRole('heading', { level: 2, name: `TU Section ${suffix}` })).toBeVisible();

      const rows = block.getByTestId('topic-updates-row');
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0).getByRole('link', { name: `TU Newer ${suffix}` })).toBeVisible();
      await expect(rows.nth(1).getByRole('link', { name: `TU Older ${suffix}` })).toBeVisible();
      await expect(block.getByRole('link', { name: `TU Elsewhere ${suffix}` })).toHaveCount(0);
      await expect(block.getByRole('link', { name: `TU Untagged ${suffix}` })).toHaveCount(0);

      // Brief, then `date · N min read`, and no topic label — we are on the topic.
      await expect(rows.nth(0)).toContainText(`Newer brief ${suffix}`);
      const meta = rows.nth(0).locator('.kp-item-meta');
      await expect(meta).toContainText('min read');
      await expect(meta).not.toContainText(name);

      const more = block.getByRole('link', { name: `View all updates in ${name}` });
      await expect(more).toBeVisible();
      await expect(more).toHaveAttribute('href', new RegExp(`topic=${slug}`));
    } finally {
      await putSections(apiAsAdmin, saved);
    }
  });

  test('a topic with nothing tagged falls back to "Recently updated"; a blog topic does not repeat its feed', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const docs = `tr-docs-${suffix}`;
    const blog = `tr-blog-${suffix}`;
    await createTopic(apiAsAdmin, { name: `Docs Topic ${suffix}`, slug: docs, presentation: 'docs' });
    await createTopic(apiAsAdmin, { name: `Blog Topic ${suffix}`, slug: blog, presentation: 'blog' });

    await createPageViaApi(apiAsAdmin, {
      title: `TR First ${suffix}`,
      body: 'First.',
      status: 'published',
      frontmatter: { type: 'Concept', topic: docs, published_at: '2026-01-01T12:00:00.000Z' },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `TR Second ${suffix}`,
      body: 'Second.',
      status: 'published',
      frontmatter: { type: 'how-to', topic: docs, published_at: '2026-02-01T12:00:00.000Z' },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `TR Draft ${suffix}`,
      body: 'Draft.',
      status: 'draft',
      frontmatter: { type: 'Concept', topic: docs },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `TR Post ${suffix}`,
      body: 'A post.',
      status: 'published',
      frontmatter: { type: 'Blog Post', topic: blog, published_at: '2026-02-01T12:00:00.000Z' },
    });

    await signedInPage.goto(`/topics/${docs}`);
    const block = signedInPage.getByTestId('topic-updates');
    await expect(block).toHaveAttribute('data-variant', 'recent');
    await expect(block.getByRole('heading', { level: 2, name: 'Recently updated' })).toBeVisible();
    const rows = block.getByTestId('topic-updates-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).getByRole('link', { name: `TR Second ${suffix}` })).toBeVisible();
    await expect(rows.nth(1).getByRole('link', { name: `TR First ${suffix}` })).toBeVisible();
    await expect(block.getByRole('link', { name: `TR Draft ${suffix}` })).toHaveCount(0);

    await signedInPage.goto(`/topics/${blog}`);
    await expect(signedInPage.getByRole('link', { name: `TR Post ${suffix}` }).first()).toBeVisible();
    await expect(signedInPage.getByRole('heading', { name: 'Recently updated' })).toHaveCount(0);
  });

  test('Popular appears once three items have distinct readers, ranked by readers, and not below that', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const slug = `tp-${suffix}`;
    const name = `Popular Topic ${suffix}`;
    const quiet = `tp-quiet-${suffix}`;
    await createTopic(apiAsAdmin, { name, slug, presentation: 'portal' });
    await createTopic(apiAsAdmin, { name: `Quiet Topic ${suffix}`, slug: quiet });

    const one = await createPageViaApi(apiAsAdmin, { title: `TP One ${suffix}`, body: 'x', status: 'published', frontmatter: { topic: slug } });
    const three = await createPageViaApi(apiAsAdmin, { title: `TP Three ${suffix}`, body: 'x', status: 'published', frontmatter: { topic: slug } });
    const two = await createPageViaApi(apiAsAdmin, { title: `TP Two ${suffix}`, body: 'x', status: 'published', frontmatter: { topic: slug } });
    const quietA = await createPageViaApi(apiAsAdmin, { title: `TQ A ${suffix}`, body: 'x', status: 'published', frontmatter: { topic: quiet } });
    const quietB = await createPageViaApi(apiAsAdmin, { title: `TQ B ${suffix}`, body: 'x', status: 'published', frontmatter: { topic: quiet } });

    const readers: APIRequestContext[] = [];
    for (const n of ['a', 'b', 'c']) {
      readers.push(await createUserApiContext(playwright, apiAsAdmin, { username: `tp-reader-${n}-${suffix}` }));
    }
    try {
      const [a, b, c] = readers as [APIRequestContext, APIRequestContext, APIRequestContext];
      // Reader a opens "One" three times: still one reader.
      await recordView(a, one.id);
      await recordView(a, one.id);
      await recordView(a, one.id);
      for (const r of [a, b, c]) await recordView(r, three.id);
      for (const r of [a, b]) await recordView(r, two.id);
      // The quiet topic has only two viewed items: below the threshold.
      await recordView(a, quietA.id);
      await recordView(b, quietB.id);
    } finally {
      for (const r of readers) await r.dispose();
    }

    await signedInPage.goto(`/topics/${slug}`);
    const popular = signedInPage.getByTestId('topic-popular');
    await expect(popular.getByRole('heading', { level: 2, name: `Popular in ${name}` })).toBeVisible();
    const rows = popular.getByTestId('topic-popular-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText(`TP Three ${suffix}`);
    await expect(rows.nth(0)).toContainText('3 readers');
    await expect(rows.nth(1)).toContainText(`TP Two ${suffix}`);
    await expect(rows.nth(1)).toContainText('2 readers');
    await expect(rows.nth(2)).toContainText(`TP One ${suffix}`);
    await expect(rows.nth(2)).toContainText('1 reader');
    await rows.nth(0).getByRole('link', { name: `TP Three ${suffix}` }).click();
    await expect(signedInPage).toHaveURL(new RegExp(`/p/${three.slug}$`));

    // Popular is judged absent only after its request has answered; otherwise
    // "not rendered yet" would pass for "hidden below the threshold".
    const answered = signedInPage.waitForResponse((r) => r.url().includes('/api/v1/popular') && r.url().includes(`topic=${quiet}`));
    await signedInPage.goto(`/topics/${quiet}`);
    expect((await (await answered).json()).items).toHaveLength(2);
    await expect(signedInPage.getByTestId('topic-updates')).toBeVisible();
    await expect(signedInPage.getByTestId('topic-popular')).toHaveCount(0);
    await expect(signedInPage.getByRole('heading', { name: /^Popular in/ })).toHaveCount(0);
  });
});
