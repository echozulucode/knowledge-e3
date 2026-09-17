import { test, expect, createPageViaApi } from './fixtures.js';
import type { APIRequestContext } from '@playwright/test';

/**
 * Tag-driven Sections on the front page (features/16-home-sections.feature).
 *
 * This is the assertion the whole change exists for. The site-wide feed is
 * opt-out — a curator can age an item out of it but cannot say "THESE are our
 * updates". A Section filtered to the tags the curator names is how they say it.
 *
 * Since the front page was cut over (2026-09-12) there is exactly one home page
 * and a topic's `presentation:` profile no longer decides its shape, so these
 * tests no longer flip the home topic to `portal` and back. Where a Section
 * lands is decided by `slot`, `order` and whether it names a topic — a
 * cross-topic Section with the lowest `order` becomes the Updates feed at the top,
 * everything else renders below the fold under its slot heading.
 */

/** Sections are a whole-catalog PUT, so append rather than replace. */
async function appendSections(api: APIRequestContext, sections: Record<string, unknown>[]) {
  const current = await api.get('/api/v1/sections');
  if (!current.ok()) throw new Error(`list sections failed: ${current.status()}`);
  const existing = ((await current.json()).sections ?? []) as Record<string, unknown>[];
  const res = await api.put('/api/v1/sections', { data: { sections: [...existing, ...sections] } });
  if (!res.ok()) throw new Error(`save sections failed: ${res.status()} ${await res.text()}`);
  return existing;
}

async function replaceSections(api: APIRequestContext, sections: Record<string, unknown>[]) {
  await api.put('/api/v1/sections', { data: { sections } });
}

test.describe('front-page sections', () => {
  test('a tag-filtered Section on the home topic renders its items on the front page', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;

    // Three tagged posts in the home topic, deliberately created out of date
    // order so the assertion proves the configured sort rather than insertion.
    await createPageViaApi(apiAsAdmin, {
      title: `Hub Update One ${suffix}`,
      body: 'Oldest update.',
      status: 'published',
      tags: ['update'],
      frontmatter: { type: 'Blog Post', topic: 'default', published_at: '2026-01-01T00:00:00.000Z' },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `Hub Update Three ${suffix}`,
      body: 'Newest update.',
      status: 'published',
      tags: ['announcement'],
      frontmatter: { type: 'Blog Post', topic: 'default', published_at: '2026-03-01T00:00:00.000Z' },
    });
    await createPageViaApi(apiAsAdmin, {
      title: `Hub Update Two ${suffix}`,
      body: 'Middle update.',
      status: 'published',
      tags: ['release'],
      frontmatter: { type: 'Blog Post', topic: 'default', published_at: '2026-02-01T00:00:00.000Z' },
    });
    // Same topic and type, no tag: proves the section is tag-driven and not just
    // "the newest Blog Posts in this topic".
    await createPageViaApi(apiAsAdmin, {
      title: `Hub Untagged ${suffix}`,
      body: 'Not an update.',
      status: 'published',
      frontmatter: { type: 'Blog Post', topic: 'default', published_at: '2026-04-01T00:00:00.000Z' },
    });
    // Carries the tag but is a draft.
    await createPageViaApi(apiAsAdmin, {
      title: `Hub Draft Update ${suffix}`,
      body: 'Unpublished.',
      status: 'draft',
      tags: ['update'],
      frontmatter: { type: 'Blog Post', topic: 'default' },
    });

    const before = await appendSections(apiAsAdmin, [
      {
        name: `Company updates ${suffix}`,
        slug: `company-updates-${suffix}`,
        description: `What the team shipped ${suffix}.`,
        type: 'Blog Post',
        space: 'default',
        tags: ['update', 'release', 'announcement'],
        slot: 'latest',
        order: 1,
      },
      // A second section naming a tag nobody uses: it must cost the front page
      // nothing at all, because tags here are emergent, not curated.
      {
        name: `Ghost section ${suffix}`,
        slug: `ghost-${suffix}`,
        space: 'default',
        tags: [`no-such-tag-${suffix}`],
        slot: 'advanced',
        order: 2,
      },
    ]);

    try {
      await signedInPage.goto('/');
      const main = signedInPage.locator('main.Home');
      await expect(main).toBeVisible();

      // The slot decides the heading, exactly as on a topic landing page.
      const updates = main.locator(`#section-company-updates-${suffix}`);
      await expect(updates).toHaveAttribute('data-slot', 'latest');
      await expect(updates.getByRole('heading', { name: 'Latest' })).toBeVisible();
      await expect(updates.getByText(`What the team shipped ${suffix}.`)).toBeVisible();

      // Scoped to this run's suffix: a reused database keeps earlier runs' items.
      const titles = updates.locator('li a', { hasText: new RegExp(`^Hub Update .* ${suffix}$`) });
      await expect(titles).toHaveText([
        `Hub Update Three ${suffix}`,
        `Hub Update Two ${suffix}`,
        `Hub Update One ${suffix}`,
      ]);

      await expect(updates.getByRole('link', { name: `Hub Untagged ${suffix}` })).toHaveCount(0);
      await expect(updates.getByRole('link', { name: `Hub Draft Update ${suffix}` })).toHaveCount(0);

      // A tag nobody uses resolves to no items, so the section is dropped rather
      // than rendering an empty heading — and never errors.
      await expect(main.locator(`#section-ghost-${suffix}`)).toHaveCount(0);
      await expect(main.getByRole('heading', { name: 'Advanced' })).toHaveCount(0);

      // The Updates feed at the top of the page is a different thing from this
      // curated Section and is still there alongside it, rather than either one
      // replacing the other.
      await expect(main.getByTestId('home-lead')).toBeVisible();

      // The curated section reaches its item.
      await updates.getByRole('link', { name: `Hub Update Three ${suffix}` }).click();
      await expect(signedInPage).toHaveURL(/\/p\//);
      await expect(signedInPage.getByRole('heading', { level: 1, name: `Hub Update Three ${suffix}` })).toBeVisible();
    } finally {
      await replaceSections(apiAsAdmin, before);
    }
  });

  test('a Section with no topic spans every topic on the front page, without leaking a private one', async ({ signedInPage, browser, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const tag = `xtupdate-${suffix}`;

    const topic = async (slug: string, extra: Record<string, unknown> = {}) => {
      const res = await apiAsAdmin.post('/api/v1/topics', { data: { name: slug, slug, ...extra } });
      if (!res.ok()) throw new Error(`seed topic failed: ${res.status()} ${await res.text()}`);
    };
    await topic(`xt-open-${suffix}`);
    await topic(`xt-secret-${suffix}`, { visibility: 'private' });

    await createPageViaApi(apiAsAdmin, {
      title: `Open Topic Update ${suffix}`,
      body: 'From a public topic.',
      status: 'published',
      tags: [tag],
      frontmatter: { type: 'Blog Post', topic: `xt-open-${suffix}`, published_at: '2026-01-01T00:00:00.000Z' },
    });
    // Same tag, a different topic again — the section must span both.
    await createPageViaApi(apiAsAdmin, {
      title: `Home Topic Update ${suffix}`,
      body: 'From the home topic.',
      status: 'published',
      tags: [tag],
      frontmatter: { type: 'Blog Post', topic: 'default', published_at: '2026-02-01T00:00:00.000Z' },
    });
    // Published, carries the tag, but lives in a private topic.
    await createPageViaApi(apiAsAdmin, {
      title: `Secret Topic Update ${suffix}`,
      body: 'From a private topic.',
      status: 'published',
      tags: [tag],
      frontmatter: { type: 'Blog Post', topic: `xt-secret-${suffix}`, published_at: '2026-03-01T00:00:00.000Z' },
    });

    // No `space`: this is the cross-topic case. `order: 1` leaves the lead to
    // the instance's own Updates section (`just seed` writes it at `order: 0`), so
    // this one renders below the fold under its slot heading — which is the
    // arrangement a second cross-topic Section is supposed to get.
    const before = await appendSections(apiAsAdmin, [
      { name: `Across topics ${suffix}`, slug: `across-${suffix}`, tags: [tag], slot: 'essential', order: 1 },
    ]);

    try {
      await signedInPage.goto('/');
      const section = signedInPage.locator(`main.Home #section-across-${suffix}`);
      await expect(section.getByRole('heading', { name: 'Essential guidance' })).toBeVisible();
      await expect(section.locator('li a', { hasText: `Topic Update ${suffix}` })).toHaveText([
        `Secret Topic Update ${suffix}`,
        `Home Topic Update ${suffix}`,
        `Open Topic Update ${suffix}`,
      ]);

      // A cross-topic section is the front page's alone: it must not repeat on
      // every topic landing in the instance.
      await signedInPage.goto(`/topics/xt-open-${suffix}`);
      await expect(signedInPage.locator(`#section-across-${suffix}`)).toHaveCount(0);

      // The security rule, through the real page: `private` means "not exposed
      // to anonymous visitors". The other two items still render, which is what
      // proves the gate is the visibility rule and not an empty section.
      //
      // A genuinely fresh context, NOT the `page` fixture: `signedInPage` signs
      // in on that very Page, so `page` in the same test is the admin's session
      // and would assert nothing at all here.
      const anonContext = await browser.newContext({ baseURL: new URL(signedInPage.url()).origin });
      try {
        const anonPage = await anonContext.newPage();
        await anonPage.goto('/');
        const anon = anonPage.locator(`main.Home #section-across-${suffix}`);
        await expect(anon.locator('li a', { hasText: `Topic Update ${suffix}` })).toHaveText([
          `Home Topic Update ${suffix}`,
          `Open Topic Update ${suffix}`,
        ]);
        await expect(anon.getByRole('link', { name: `Secret Topic Update ${suffix}` })).toHaveCount(0);
      } finally {
        await anonContext.close();
      }
    } finally {
      await replaceSections(apiAsAdmin, before);
    }
  });

  test('an administrator can set a Section tag filter in Admin and see what it draws from', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const before = await appendSections(apiAsAdmin, []);

    try {
      // The Sections list is read-only; a section is added on its own edit page
      // (the admin UX review §4.1), with tags PICKED as chips.
      await signedInPage.goto('/admin/sections');
      await signedInPage.getByRole('link', { name: 'New section' }).first().click();
      await expect(signedInPage).toHaveURL(/\/admin\/sections\/new$/);

      await signedInPage.getByRole('textbox', { name: /^Name/ }).fill(`Admin Updates ${suffix}`);
      const topic = signedInPage.getByRole('combobox', { name: 'Topic' });
      await topic.fill('default');
      await signedInPage.getByRole('option', { name: /^Default/ }).first().click();

      const tags = signedInPage.getByRole('combobox', { name: 'Tags' });
      for (const tag of ['update', 'release']) {
        await tags.fill(tag);
        // An existing tag is listed first; a tag nobody uses yet is offered as "Create “tag”".
        await signedInPage.getByRole('option', { name: new RegExp(tag) }).first().click();
      }
      await signedInPage.getByRole('button', { name: 'Create section' }).click();
      await expect(signedInPage).toHaveURL(new RegExp(`/admin/sections/admin-updates-${suffix}$`));

      // The tags survive the round trip and are visible without opening a config
      // file — the curator can see what the section draws from.
      await signedInPage.reload();
      // The server stores tags de-duplicated and sorted (config.service.ts
      // normalizeSectionTags), so the round trip comes back in alphabetical order.
      // Chip labels, not whole list items (each also holds its Remove (×) button).
      const chips = signedInPage.getByRole('list', { name: 'Chosen' }).locator('.kp-picker__chipLabel');
      await expect(chips).toHaveText(['release', 'update']);
      // And the list shows them on the section's row.
      await signedInPage.goto('/admin/sections');
      await expect(signedInPage.getByRole('row', { name: new RegExp(`Admin Updates ${suffix}`) })).toContainText('release');
    } finally {
      await replaceSections(apiAsAdmin, before);
    }
  });
});
