import { test, expect, createPageViaApi, createUserApiContext } from './fixtures.js';
import playwright from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * Maps to features/14-external-sources.feature.
 *
 * A page only carries a `source` once its file was indexed out of a registered
 * source, and a `changed_on_disk` refusal needs the file on disk to have moved
 * under the index. Neither can be arranged from the browser, so both are staged
 * at the boundary the UI actually consumes: the page read and the save. What is
 * under test here is the reader's and Compose's response to those shapes, which
 * is exactly what issue 87 says is missing.
 *
 * The last describe is the one that keeps requirement 4 true after everyone has
 * forgotten the plan (reader UX plan §6): a corpus spread over two sources has
 * to behave as one, and say nothing about being two.
 */

const REFERENCE_SOURCE = {
  id: 'topic:other-team-docs',
  role: 'reference' as const,
  mode: 'read-only' as const,
  path: 'concepts/retry-budget.md',
  url: 'https://github.com/other-team/docs/blob/main/concepts/retry-budget.md',
};

/** Serve the page read with `source` grafted on, leaving everything else the server said. */
async function withSource(page: Page, slug: string, source: unknown): Promise<void> {
  await page.route(`**/api/v1/pages/by-slug/${slug}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.page.source = source;
    await route.fulfill({ status: response.status(), contentType: 'application/json', body: JSON.stringify(body) });
  });
}

function markdownEditor(page: Page) {
  return page.locator('.cm-content, .me-wysiwyg-input, .ProseMirror').first();
}

/**
 * One result row by its title. Filtering the row on its whole text is not
 * enough here: the linking item's snippet quotes the linked item's title, so
 * both rows match it.
 */
function resultRow(page: Page, title: string) {
  return page.locator('.Search__row').filter({ has: page.locator('.kp-result-row__title', { hasText: title }) });
}

test.describe('reading an item from a reference source', () => {
  test('says only that it is maintained elsewhere, and offers the original', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    const item = await createPageViaApi(apiAsAdmin, {
      title: `Maintained Concept ${testInfo.workerIndex}-${Date.now()}`,
      body: 'Indexed from another team\'s bundle.',
      status: 'published',
    });
    await withSource(signedInPage, item.slug, REFERENCE_SOURCE);

    await signedInPage.goto(`/p/${item.slug}`);

    const badge = signedInPage.getByText('Maintained elsewhere', { exact: true });
    await expect(badge).toBeVisible();
    // Plan §6, R4.1: the claim, never the registry id or the file path.
    await expect(badge).toHaveAttribute('title', 'This page is maintained by another team and kept up to date automatically.');

    const original = signedInPage.getByRole('link', { name: 'View the original' });
    await expect(original).toHaveAttribute('href', REFERENCE_SOURCE.url);
    await expect(original).toHaveAttribute('target', '_blank');
    await expect(original).toHaveAttribute('rel', 'noopener noreferrer');

    // Read-only: nothing here writes back, so the editor is not offered at all.
    await expect(signedInPage.getByRole('button', { name: 'Edit page' })).toHaveCount(0);
    await expect(signedInPage.getByText(/Changes to this page are made by the team that owns it/i)).toBeVisible();
  });

  test('makes the same claim, with no link, when the host has no derivable web address', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    const item = await createPageViaApi(apiAsAdmin, {
      title: `Maintained Over Ssh ${testInfo.workerIndex}-${Date.now()}`,
      body: 'Indexed from a remote we cannot address.',
      status: 'published',
    });
    await withSource(signedInPage, item.slug, { ...REFERENCE_SOURCE, url: null });

    await signedInPage.goto(`/p/${item.slug}`);

    await expect(signedInPage.getByText('Maintained elsewhere', { exact: true })).toBeVisible();
    // No dead link, no invented URL, and — unlike before — no explanation of
    // why there is no link, which was the plumbing explaining itself.
    await expect(signedInPage.getByRole('link', { name: 'View the original' })).toHaveCount(0);
    await expect(signedInPage.getByText(/no web link/i)).toHaveCount(0);
  });

  /**
   * Withdrawing the Edit action closes the door an author can see. It does not
   * close the one they may already have in a bookmark, and a refusal discovered
   * by typing a page of prose and then pressing Save is the expensive kind. So
   * Compose states it on arrival instead — the read-only refusal's new home,
   * since Compose is where authoring went.
   */
  test('arriving at Compose by URL is refused up front, with the way to the original', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    const item = await createPageViaApi(apiAsAdmin, {
      title: `Read Only By Url ${testInfo.workerIndex}-${Date.now()}`,
      body: 'Owned by another team.',
      status: 'published',
    });
    await withSource(signedInPage, item.slug, REFERENCE_SOURCE);

    await signedInPage.goto(`/p/${item.slug}/edit`);

    const refusal = signedInPage.getByRole('note', { name: /read-only source/i });
    await expect(refusal).toBeVisible({ timeout: 15_000 });
    await expect(refusal).toContainText(/this item cannot be edited here/i);
    await expect(refusal).toContainText(/Changes to this page are made by the team that owns it/i);

    // No editor at all — not a disabled one, which would still invite typing.
    await expect(markdownEditor(signedInPage)).toHaveCount(0);
    await expect(signedInPage.getByRole('region', { name: /item save status/i })).toHaveCount(0);

    await expect(refusal.getByRole('link', { name: /view the original/i })).toHaveAttribute('href', REFERENCE_SOURCE.url);
    await refusal.getByRole('link', { name: /back to the item/i }).click();
    await expect(signedInPage).toHaveURL((url) => url.pathname === `/p/${item.slug}`, { timeout: 15_000 });
  });
});

test.describe('saving over a file that changed outside the app', () => {
  test('reports the change and offers a reload instead of a version comparison', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    const item = await createPageViaApi(apiAsAdmin, {
      title: `Edited In VS Code ${testInfo.workerIndex}-${Date.now()}`,
      body: 'Body indexed before the file moved.',
      status: 'draft',
    });

    await signedInPage.route(`**/api/v1/pages/${item.id}`, async (route, request) => {
      if (request.method() !== 'PUT') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          message: `The file for this item changed on disk since it was last indexed (main/${item.slug}.md); reindex it before editing`,
          reason: 'changed_on_disk',
          file_path: `main/${item.slug}.md`,
        }),
      });
    });

    await signedInPage.goto(`/p/${item.slug}/edit`);
    const editor = markdownEditor(signedInPage);
    await editor.click();
    await editor.press('Control+End');
    await editor.type(' My unsaved sentence.');

    const saveStatus = signedInPage.getByRole('region', { name: /item save status/i });
    await saveStatus.getByRole('button', { name: /save draft/i }).click();

    const banner = signedInPage.getByRole('alert').filter({ hasText: 'Changed outside the app' });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText(/changed outside the app/i);
    await expect(banner.getByRole('button', { name: 'Reload' })).toBeVisible();

    // The version comparison would be misleading: the stored version is not
    // what moved, the file is.
    await expect(signedInPage.getByRole('heading', { name: /edit conflict/i })).toHaveCount(0);
    await expect(editor).toContainText(/My unsaved sentence/i);
  });

  test('a 409 with no reason is still the version conflict it always was', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    const item = await createPageViaApi(apiAsAdmin, {
      title: `Concurrently Edited ${testInfo.workerIndex}-${Date.now()}`,
      body: 'Body before the other save.',
      status: 'draft',
    });

    // Staged rather than raced against autosave: what matters is that the 409
    // WITHOUT a reason still reaches the version comparison it always did.
    await signedInPage.route(`**/api/v1/pages/${item.id}`, async (route, request) => {
      if (request.method() !== 'PUT') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Version conflict: the item was modified by someone else' }),
      });
    });

    await signedInPage.goto(`/p/${item.slug}/edit`);
    const editor = markdownEditor(signedInPage);
    await editor.click();
    await editor.press('Control+End');
    await editor.type(' My local sentence.');

    const saveStatus = signedInPage.getByRole('region', { name: /item save status/i });
    await saveStatus.getByRole('button', { name: /save draft/i }).click();

    await expect(signedInPage.getByRole('heading', { name: /edit conflict/i })).toBeVisible({ timeout: 15_000 });
    await expect(signedInPage.getByRole('alert').filter({ hasText: 'Changed outside the app' })).toHaveCount(0);
  });
});

/**
 * The words this product must never put in front of a reader. Deliberately a
 * blunt instrument over rendered text: the specific leaks fixed in wave 5 will
 * be forgotten long before the next one is written, and this catches that one
 * too. If it fires on something legitimate, narrow `readerVisibleText`'s scope
 * and say why — never soften the pattern.
 */
const PLUMBING = /repositor|repo\b|upstream|sync|mirror|topic:|concepts\//i;

/**
 * The one known false positive, recorded here so it is never "fixed" by
 * softening PLUMBING. `topic:` also matches the sanctioned reader label
 * "Topic: <name>" — a browse filter chip — which is the correct vocabulary since
 * issue 110. No inspected surface renders one today: search rows no longer show
 * reason chips at all (matched fields are a `data-match` attribute of field
 * names, never "Topic: …"). If that
 * changes, narrow `expectNoPlumbing` to strip /Topic: / — case-sensitive and
 * with the space required, so it cannot hide a `topic:<id>` registry id — and
 * say why in the diff. Never widen the pattern.
 */

/**
 * Everything on the page a reader can perceive: the rendered text, plus the
 * attributes that are read aloud, hovered, or shown as a hint. Hidden subtrees
 * are excluded by `innerText`, and `href`/`src` are deliberately NOT collected —
 * a link to the original is fine, it is the path on screen that is not. Class
 * names are not reader-visible and are not collected either.
 *
 * **One scope narrowing, 2026-09-12 (plan B1).** `[data-operator-location]` is
 * excluded: it is the "Where this lives" block, the one place in the product
 * that is deliberately about the plumbing. It is not softening the rule, because
 * what it may contain is decided by the SERVER, not by this page —
 * `redactSourceForViewer` gives the file path to an admin and to nobody else,
 * and drops `url` for an anonymous visitor, so the block does not render at all
 * for a reader with no account. `renders nothing for a viewer the server told
 * nothing` below is the test of that, and it is a stronger guarantee than this
 * regex was ever able to make. Never widen the exclusion; never widen PLUMBING.
 */
async function readerVisibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    // Hidden rather than removed: `innerText` already skips hidden subtrees,
    // which is what keeps the closed "Show all properties" disclosure in scope,
    // and the page is left exactly as it was found.
    const operator = Array.from(document.querySelectorAll<HTMLElement>('[data-operator-location]'));
    const restore = operator.map((el) => el.style.display);
    for (const el of operator) el.style.display = 'none';
    const parts: string[] = [document.body.innerText ?? ''];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (operator.some((o) => o.contains(el))) continue;
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name;
        if (name === 'title' || name === 'alt' || name === 'placeholder' || name.startsWith('aria-') || name.startsWith('data-')) {
          parts.push(attr.value);
        }
      }
    }
    operator.forEach((el, i) => {
      el.style.display = restore[i] ?? '';
    });
    return parts.join('\n');
  });
}

async function expectNoPlumbing(page: Page, where: string): Promise<void> {
  const visible = await readerVisibleText(page);
  const offending = visible
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => PLUMBING.test(line));
  expect(offending, `${where} shows the instance's plumbing to a reader`).toEqual([]);
}

test.describe('one corpus, however many repositories it lives in', () => {
  /**
   * Two topics bound to two different sources, sharing a tag and joined by a
   * wiki-link. The data layer never had a source predicate — `SearchService`
   * has none, `backlinks()` has no space or source clause, the link index is
   * instance-wide — so this is a test of what the product SAYS, not of what it
   * can do (plan §1.1, last bullet).
   */
  async function seedTwoSources(api: APIRequestContext, marker: string) {
    const tag = `unified-${marker}`;
    const target = await createPageViaApi(api, {
      title: `Retry Budget ${marker}`,
      body: `How long a caller keeps trying. ${marker}`,
      status: 'published',
      tags: [tag],
      frontmatter: { topic: `Platform Handbook ${marker}`, type: 'Runbook' },
    });
    const linker = await createPageViaApi(api, {
      title: `Timeout Policy ${marker}`,
      body: `Set the deadline first, then see [[Retry Budget ${marker}]] for the rest. ${marker}`,
      status: 'published',
      tags: [tag],
      frontmatter: { topic: `Field Notes ${marker}`, type: 'Runbook' },
    });
    return { tag, target, linker };
  }

  test('search, tags and links cross the two, and nothing on screen admits there are two', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    const marker = `unifiedcorpus${testInfo.workerIndex}${Date.now()}`;
    const { tag, target, linker } = await seedTwoSources(apiAsAdmin, marker);

    // Each item reads as coming from a different place. Nothing downstream may
    // act on that, and nothing on screen may repeat it.
    await withSource(signedInPage, target.slug, REFERENCE_SOURCE);
    await withSource(signedInPage, linker.slug, {
      id: 'topic:field-notes',
      role: 'reference',
      mode: 'read-only',
      path: 'concepts/timeout-policy.md',
      url: 'https://github.com/field-team/notes/blob/main/concepts/timeout-policy.md',
    });

    // (a) One query, both sources.
    await signedInPage.goto(`/search?q=${marker}`);
    await expect(resultRow(signedInPage, `Retry Budget ${marker}`)).toBeVisible({ timeout: 15_000 });
    await expect(resultRow(signedInPage, `Timeout Policy ${marker}`)).toBeVisible();
    await expectNoPlumbing(signedInPage, 'the search results');

    // (b) One tag, both sources — the tag surface is `/search`, so "everything
    // about this" is one ranked, faceted answer (plan §6, R4.7).
    await signedInPage.goto(`/search?tag=${tag}`);
    await expect(resultRow(signedInPage, `Retry Budget ${marker}`)).toBeVisible({ timeout: 15_000 });
    await expect(resultRow(signedInPage, `Timeout Policy ${marker}`)).toBeVisible();
    await expectNoPlumbing(signedInPage, 'the tag surface');

    // (c) The link from one source to the other is a Related entry on the
    // article, not a collapsed panel two clicks into a rail.
    await signedInPage.goto(`/p/${target.slug}`);
    const related = signedInPage.getByRole('region', { name: 'Related' });
    await expect(related.getByRole('link', { name: `Timeout Policy ${marker}` })).toBeVisible({ timeout: 15_000 });
    await expectNoPlumbing(signedInPage, 'the article');

    // And the reader can walk it, arriving on a page maintained somewhere else
    // again without being told so.
    await related.getByRole('link', { name: `Timeout Policy ${marker}` }).click();
    await expect(signedInPage).toHaveURL((url) => url.pathname === `/p/${linker.slug}`, { timeout: 15_000 });
    await expectNoPlumbing(signedInPage, 'the linked article');
  });

  /**
   * A tag is the one surface a reader uses to ask "everything about this",
   * which is exactly the question a split corpus answers badly. It leads to the
   * ranked, faceted surface rather than to /browse (plan §6, R4.7).
   */
  test('a tag on the article leads to the ranked surface, carrying the tag', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    const marker = `tagdest${testInfo.workerIndex}${Date.now()}`;
    const { tag, target } = await seedTwoSources(apiAsAdmin, marker);

    await signedInPage.goto(`/p/${target.slug}`);
    await signedInPage.getByRole('tab', { name: 'Tags' }).click();
    await signedInPage.getByRole('button', { name: tag, exact: true }).click();

    await expect(signedInPage).toHaveURL(
      (url) => url.pathname === '/search' && url.searchParams.get('tag') === tag,
      { timeout: 15_000 },
    );
    await expect(resultRow(signedInPage, `Timeout Policy ${marker}`)).toBeVisible({ timeout: 15_000 });
  });

  /**
   * Plan §6, R4.4: the pane is an allow-list, so a frontmatter key nobody
   * anticipated is not on a reader's screen the day it is introduced.
   */
  test('the properties pane shows the allow-list, and hides the rest behind a disclosure', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    const marker = `props${testInfo.workerIndex}${Date.now()}`;
    const item = await createPageViaApi(apiAsAdmin, {
      title: `Allow Listed Properties ${marker}`,
      body: 'A page carrying machinery in its frontmatter.',
      status: 'published',
      frontmatter: {
        topic: `Platform Handbook ${marker}`,
        type: 'Runbook',
        e3_id: 'e3-0001',
        okf_version: '0.2',
        generated: true,
        source: 'concepts/allow-listed.md',
      },
    });

    await signedInPage.goto(`/p/${item.slug}`);
    await signedInPage.getByRole('tab', { name: 'Properties' }).click();

    const pane = signedInPage.locator('.kp-ctx-props').first();
    await expect(pane).toContainText('Type');
    await expect(pane).toContainText('Topic');
    await expect(pane).toContainText('Updated');

    const disclosure = signedInPage.locator('.kp-ctx-more');
    await expect(disclosure.locator('summary')).toHaveText('Show all properties');
    // Closed, so none of it is on screen until a reader asks for it.
    await expect(disclosure.locator('dl')).toBeHidden();
    await expectNoPlumbing(signedInPage, 'the properties pane');

    await disclosure.locator('summary').click();
    await expect(disclosure).toContainText('E3 Id');
    await expect(disclosure).toContainText('Okf Version');
  });
});

/**
 * Plan B1 — "where this lives", on every item.
 *
 * The asymmetry the two halves of the UX plan are built on, tested from both
 * sides of it on ONE item: the administrator is owed the truth about which
 * repository a file is in, and the reader is owed a single library. Nothing is
 * staged here on purpose — the redaction that produces the difference lives in
 * `redactSourceForViewer` on the server, and a test that mocked the response
 * would be testing the mock.
 */
test.describe('where this lives', () => {
  function location(page: Page) {
    return page.locator('[data-operator-location]');
  }

  /**
   * An item's `source` is the join of its `source_id` with a REGISTERED source
   * row: `sourceRefFrom` returns null when the registry has no such row, and a
   * fresh e2e instance has an empty registry. So the item written below is only
   * the one B1 is about once `main` is registered — which is what a real
   * instance has, and what the plan means by "already on the wire".
   */
  async function withMainRegistered<T>(api: APIRequestContext, work: () => Promise<T>): Promise<T> {
    const registered = await api.put('/api/v1/admin/sources/main', {
      data: { remote_url: null, mode: 'direct', role: 'authoritative', local_dir: 'main', enabled: true },
    });
    if (!registered.ok()) throw new Error(`register main failed: ${registered.status()} ${await registered.text()}`);
    try {
      return await work();
    } finally {
      await api.delete('/api/v1/admin/sources/main');
    }
  }

  test('an admin reads the repository and the file path, on the page and in Compose', async ({
    signedInPage,
    apiAsAdmin,
  }, testInfo) => {
    await withMainRegistered(apiAsAdmin, async () => {
      const item = await createPageViaApi(apiAsAdmin, {
        title: `Where This Lives ${testInfo.workerIndex}-${Date.now()}`,
        body: 'Written through the API, so it has a real canonical file.',
        status: 'published',
      });
      const view = await (await apiAsAdmin.get(`/api/v1/pages/by-slug/${item.slug}`)).json();
      const source = view.page.source as { id: string; path: string | null } | null;
      expect(source, 'an item written through the write path records its source').toBeTruthy();
      expect(source?.path, 'and an admin is entitled to the path').toBeTruthy();
      const path = source!.path!;

      await signedInPage.goto(`/p/${item.slug}`);
      await signedInPage.getByRole('tab', { name: 'Properties' }).click();
      await expect(signedInPage.locator('.kp-ctx-props').first()).toContainText('Where this lives');
      await expect(location(signedInPage)).toContainText(source!.id);
      await expect(location(signedInPage)).toContainText(path);

      // The same answer where an author stands, not only where a reader does.
      await signedInPage.goto(`/p/${item.slug}/edit`);
      const saveStatus = signedInPage.getByRole('region', { name: /item save status/i });
      await saveStatus.getByRole('button', { name: /publish/i }).click({ timeout: 15_000 });
      const drawer = location(signedInPage);
      await expect(drawer).toContainText('Where this lives', { timeout: 15_000 });
      await expect(drawer).toContainText(path);
    });
  });

  test('renders nothing for a viewer the server told nothing', async ({ browser, apiAsAdmin, baseURL }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    await withMainRegistered(apiAsAdmin, async () => {
      const item = await createPageViaApi(apiAsAdmin, {
        title: `Not For Readers ${suffix}`,
        body: 'The same item, read by somebody without an operator account.',
        status: 'published',
      });
      // The admin's view of this very item carries the path, so what follows is
      // the redaction and not an item that simply has nothing to show.
      const asAdmin = await (await apiAsAdmin.get(`/api/v1/pages/by-slug/${item.slug}`)).json();
      expect(asAdmin.page.source.path).toBeTruthy();

      const username = `reader-b1-${suffix}`;
      const password = 'user-dev-password-123';
      const reader = await createUserApiContext(playwright, apiAsAdmin, { username, password });
      // The server's answer first: a signed-in reader is given the trust claims
      // and no path at all. `url` would survive a sign-in — there is none here
      // because this instance's `main` source has no remote to address.
      const view = await (await reader.get(`/api/v1/pages/by-slug/${item.slug}`)).json();
      expect(view.page.source.id).toBe('main');
      expect(view.page.source.path ?? null).toBeNull();
      expect(view.page.source.url ?? null).toBeNull();
      await reader.dispose();

      // A genuinely fresh context, and NOT the `page` fixture: `signedInPage`
      // signs in on that very Page. A context made by hand does not inherit the
      // project's baseURL, so it is passed through.
      const context = await browser.newContext({ baseURL });
      try {
        const page = await context.newPage();
        await page.goto('/login');
        await page.getByLabel('Username').fill(username);
        await page.getByLabel('Password').fill(password);
        await page.getByRole('button', { name: /sign in/i }).click();
        await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 });

        await page.goto(`/p/${item.slug}`);
        await page.getByRole('tab', { name: 'Properties' }).click();
        await expect(page.locator('.kp-ctx-props').first()).toContainText('Type');
        await expect(location(page)).toHaveCount(0);
        await expectNoPlumbing(page, 'the article as a reader sees it');
      } finally {
        await context.close();
      }
    });
  });
});
