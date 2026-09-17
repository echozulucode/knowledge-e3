import { test, expect, createPageViaApi } from './fixtures.js';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * Topics admin: the read-only catalog, the New topic dialog and the dedicated
 * edit page (the admin UX review §4.5; features/11-topic-landing.feature).
 *
 * Every test seeds its own uniquely named topics, so nothing here depends on or
 * disturbs another spec's catalog. Topics cannot be un-archived, so only topics
 * a test created itself are ever archived.
 */

type Json = Record<string, unknown>;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function makeTopic(api: APIRequestContext, data: Json): Promise<Json> {
  const res = await api.post('/api/v1/topics', { data });
  if (!res.ok()) throw new Error(`seed topic failed: ${res.status()} ${await res.text()}`);
  return (await res.json()).topic as Json;
}

async function getTopic(api: APIRequestContext, slug: string): Promise<Json | undefined> {
  const res = await api.get('/api/v1/topics');
  if (!res.ok()) throw new Error(`list topics failed: ${res.status()}`);
  return (((await res.json()).topics ?? []) as Json[]).find((t) => t['slug'] === slug);
}

/** The catalog row for a topic, found by its name. */
function row(page: Page, name: string) {
  return page.getByRole('row', { name: new RegExp(escapeRegExp(name)) });
}

/** The row's primary link (its name) — not the Items link, whose label also names the topic. */
function rowLink(page: Page, name: string) {
  return row(page, name).getByRole('link', { name: new RegExp(`^${escapeRegExp(name)}`) });
}

test.describe('Topics admin', () => {
  test('lists topics read-only, filters Private and Empty from the URL, and searches', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const publicName = `Catalog Public ${suffix}`;
    const privateName = `Catalog Private ${suffix}`;
    const publicSlug = `catalog-public-${suffix}`;
    await makeTopic(apiAsAdmin, { name: publicName, slug: publicSlug, description: 'Discovery notes and opportunity research' });
    await makeTopic(apiAsAdmin, { name: privateName, slug: `catalog-private-${suffix}`, visibility: 'private' });
    await createPageViaApi(apiAsAdmin, { title: `Catalog Item ${suffix}`, status: 'published', frontmatter: { topic: publicSlug } });

    await page.goto('/admin/topics');
    await expect(page.getByRole('heading', { name: 'Topics', exact: true })).toBeVisible();
    await expect(page.locator('.kp-admin-header__meta')).toHaveText(/^\d+ topics?/);

    // Review §3.1: the primary action is in the header, above the catalog.
    const newTopic = page.getByRole('button', { name: 'New topic' }).first();
    const tableTop = await page.getByRole('table', { name: 'Topics' }).evaluate((node) => node.getBoundingClientRect().top);
    const buttonTop = await newTopic.evaluate((node) => node.getBoundingClientRect().top);
    expect(buttonTop).toBeLessThan(tableTop);

    const pub = row(page, publicName);
    await expect(pub).toContainText('Discovery notes and opportunity research');
    await expect(pub).toContainText('Wiki');
    await expect(pub).toContainText('Public');
    await expect(pub.getByRole('link', { name: `1 item in ${publicName}` })).toHaveAttribute('href', `/search?topic=${publicSlug}`);
    await expect(row(page, privateName)).toContainText('Private');
    await expect(row(page, privateName)).toContainText('0 items');
    // Nothing edits in place: no inputs and no buttons other than the ⋯ menu on a row.
    await expect(pub.locator('input, select, textarea')).toHaveCount(0);
    await expect(pub.getByRole('button')).toHaveCount(1);

    await page.getByRole('button', { name: /^Private \d+$/ }).click();
    await expect(page).toHaveURL(/[?&]filter=private/);
    await expect(page.getByRole('button', { name: /^Private \d+$/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(row(page, privateName)).toBeVisible();
    await expect(row(page, publicName)).toHaveCount(0);

    await page.getByRole('button', { name: /^Empty \d+$/ }).click();
    await expect(page).toHaveURL(/[?&]filter=empty/);
    await expect(row(page, privateName)).toBeVisible();
    await expect(row(page, publicName)).toHaveCount(0);

    // Back undoes a filter.
    await page.goBack();
    await expect(page).toHaveURL(/[?&]filter=private/);

    await page.goto(`/admin/topics?q=${encodeURIComponent(publicName)}`);
    await expect(page.getByRole('searchbox', { name: 'Search topics' })).toHaveValue(publicName);
    await expect(row(page, publicName)).toBeVisible();
    await expect(row(page, privateName)).toHaveCount(0);

    await page.getByRole('searchbox', { name: 'Search topics' }).fill(`no such topic ${suffix}`);
    await expect(page.getByText('No topics match')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(row(page, privateName)).toBeVisible();

    await rowLink(page, publicName).click();
    await expect(page).toHaveURL(new RegExp(`/admin/topics/${publicSlug}$`));
    await expect(page.getByRole('heading', { level: 1, name: publicName })).toBeVisible();
    // Longest-prefix nav: the edit page still lights Topics.
    await expect(page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Topics', exact: true })).toHaveAttribute('aria-current', 'page');
  });

  test('a repository URL preselects Private and says why, and the admin can still choose', async ({ signedInPage: page }) => {
    await page.goto('/admin/topics');
    await page.getByRole('button', { name: 'New topic' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New topic' });
    const publicRadio = dialog.getByRole('radio', { name: 'Public' });
    const privateRadio = dialog.getByRole('radio', { name: 'Private' });
    const why = dialog.getByText(/not visible to anonymous visitors before someone has reviewed it/i);

    await expect(publicRadio).toBeChecked();
    await expect(dialog.getByText(/private hides this topic from anonymous visitors/i)).toBeVisible();
    await expect(why).toHaveCount(0);

    // The repository binding is advanced and starts collapsed.
    const repoUrl = dialog.getByRole('textbox', { name: 'Repository URL' });
    await expect(repoUrl).toBeHidden();
    await dialog.getByText('Dedicated repository (advanced)').click();

    // Nothing is created here: entering the URL is the whole of the behaviour
    // (creating would bind and pull a repository).
    await repoUrl.fill('git@example.invalid:org/topic.git');
    await expect(privateRadio).toBeChecked();
    await expect(why).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Test connection' })).toBeEnabled();

    // The admin's choice stands, even as the URL keeps changing.
    await publicRadio.check();
    await repoUrl.fill('git@example.invalid:org/another.git');
    await expect(publicRadio).toBeChecked();

    // The form is dirty, so Cancel asks before throwing the input away.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('dialog', { name: 'Discard changes?' }).getByRole('button', { name: 'Discard' }).click();
    await expect(dialog).toHaveCount(0);

    // A fresh dialog starts from the default again.
    await page.getByRole('button', { name: 'New topic' }).first().click();
    await expect(page.getByRole('dialog', { name: 'New topic' }).getByRole('radio', { name: 'Public' })).toBeChecked();
  });

  test('creates a private topic in the dialog and opens its edit page', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const name = `Private Notes ${suffix}`;
    const slug = `private-notes-${suffix}`;

    await page.goto('/admin/topics');
    await page.getByRole('button', { name: 'New topic' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New topic' });
    await dialog.getByRole('textbox', { name: /^Name/ }).fill(name);
    // The slug follows the name, as the server will store it.
    await expect(dialog.getByRole('textbox', { name: 'Slug' })).toHaveValue(slug);
    await dialog.getByRole('textbox', { name: 'Description' }).fill('Technical build notes');
    await dialog.getByRole('radio', { name: 'Private' }).check();
    await dialog.getByRole('button', { name: 'Create topic' }).click();

    await expect(page).toHaveURL(new RegExp(`/admin/topics/${slug}$`));
    await expect(page.getByText(`Topic created: ${name}`)).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Private' })).toBeChecked();

    // Created private in the one request, not flipped afterwards.
    expect((await getTopic(apiAsAdmin, slug))?.['visibility']).toBe('private');

    // A slug already in use is refused while typing, before any request.
    await page.goto('/admin/topics');
    await page.getByRole('button', { name: 'New topic' }).first().click();
    const again = page.getByRole('dialog', { name: 'New topic' });
    await again.getByRole('textbox', { name: /^Name/ }).fill(name);
    await expect(again.getByText(`Another topic already uses /topics/${slug}.`)).toBeVisible();
    await expect(again.getByRole('button', { name: 'Create topic' })).toBeDisabled();
  });

  test('the edit page saves presentation, Start here and landing markdown in one save', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const name = `Landing Edit ${suffix}`;
    const slug = `landing-edit-${suffix}`;
    const itemTitle = `Getting Started Guide ${suffix}`;
    await makeTopic(apiAsAdmin, { name, slug });
    const item = await createPageViaApi(apiAsAdmin, { title: itemTitle, status: 'published', frontmatter: { topic: slug } });

    await page.goto(`/admin/topics/${slug}`);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Slug' })).toHaveAttribute('readonly', '');
    await expect(page.getByRole('button', { name: 'Save topic' })).toBeDisabled();

    await page.getByRole('radio', { name: 'Portal' }).check();

    const startHere = page.getByRole('combobox', { name: 'Start here' });
    await startHere.fill('Getting Started');
    await page.getByRole('option', { name: itemTitle }).click();
    await expect(startHere).toHaveValue(itemTitle);

    const markdown = page.getByRole('textbox', { name: 'Landing markdown' });
    await markdown.fill('## Welcome aboard\n\nRead the **guide** first.');
    await expect(page.getByTestId('topic-markdown-count')).toHaveText('44 / 20,000 characters');
    await page.getByRole('tab', { name: 'Preview' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Preview' }).getByRole('heading', { name: 'Welcome aboard' })).toBeVisible();
    await page.getByRole('tab', { name: 'Write' }).click();

    // The aside summarises what visitors will get.
    const aside = page.getByRole('complementary', { name: 'Landing preview' });
    await expect(aside).toContainText('Portal');
    await expect(aside).toContainText(itemTitle);
    await expect(aside.getByRole('link', { name: 'View landing page' })).toHaveAttribute('href', `/topics/${slug}`);

    await page.getByRole('button', { name: 'Save topic' }).click();
    await expect(page.getByText(`Topic saved: ${name}`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save topic' })).toBeDisabled();

    expect(await getTopic(apiAsAdmin, slug)).toMatchObject({
      presentation: 'portal',
      start_here: item.slug,
      landing_markdown: '## Welcome aboard\n\nRead the **guide** first.',
    });

    // The landing renders with that profile, and Get started opens the item.
    await page.goto(`/topics/${slug}`);
    await expect(page.locator('main[data-presentation="portal"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Welcome aboard' })).toBeVisible();
    await expect(page.getByRole('link', { name: /get started/i })).toHaveAttribute('href', `/p/${item.slug}`);
  });

  test('making a private topic public asks first, saying how many published items become readable', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const name = `Going Public ${suffix}`;
    const slug = `going-public-${suffix}`;
    await makeTopic(apiAsAdmin, { name, slug, visibility: 'private' });
    await createPageViaApi(apiAsAdmin, { title: `Public Soon ${suffix}`, status: 'published', frontmatter: { topic: slug } });

    await page.goto(`/admin/topics/${slug}`);
    const publicRadio = page.getByRole('radio', { name: 'Public' });
    const privateRadio = page.getByRole('radio', { name: 'Private' });
    await expect(privateRadio).toBeChecked();

    await publicRadio.click();
    const confirm = page.getByRole('dialog', { name: `Make ${name} public?` });
    await expect(confirm).toContainText('1 published item becomes readable by anonymous visitors.');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(privateRadio).toBeChecked();
    await expect(page.getByRole('button', { name: 'Save topic' })).toBeDisabled();

    await publicRadio.click();
    await page.getByRole('dialog', { name: `Make ${name} public?` }).getByRole('button', { name: 'Make public' }).click();
    await expect(publicRadio).toBeChecked();
    // Nothing is applied until Save.
    expect((await getTopic(apiAsAdmin, slug))?.['visibility']).toBe('private');

    await page.getByRole('button', { name: 'Save topic' }).click();
    await expect(page.getByText(`Topic saved: ${name}`)).toBeVisible();
    expect((await getTopic(apiAsAdmin, slug))?.['visibility']).toBe('public');

    // Narrowing back to Private does not ask.
    await privateRadio.click();
    await expect(page.getByRole('dialog', { name: /public\?$/ })).toHaveCount(0);
    await expect(privateRadio).toBeChecked();
  });

  test('archive is refused with a reason while a topic has items, and confirms when it is empty', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const busyName = `Archive Busy ${suffix}`;
    const busySlug = `archive-busy-${suffix}`;
    const emptyName = `Archive Empty ${suffix}`;
    const emptySlug = `archive-empty-${suffix}`;
    await makeTopic(apiAsAdmin, { name: busyName, slug: busySlug });
    await makeTopic(apiAsAdmin, { name: emptyName, slug: emptySlug });
    // A draft counts: the server refuses while ANY item is assigned.
    await createPageViaApi(apiAsAdmin, { title: `Busy Draft ${suffix}`, status: 'draft', frontmatter: { topic: busySlug } });

    await page.goto('/admin/topics');
    await page.getByRole('button', { name: `Actions for ${busyName}` }).click();
    const blocked = page.getByRole('menuitem', { name: 'Archive…' });
    await expect(blocked).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('menu')).toContainText('Has 1 item');
    await blocked.click({ force: true });
    await expect(page.getByRole('dialog', { name: `Archive ${busyName}?` })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The same rule on the edit page's danger zone.
    await page.goto(`/admin/topics/${busySlug}`);
    await expect(page.getByRole('button', { name: 'Archive…' })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText(/^Has 1 item\./)).toBeVisible();

    await page.goto('/admin/topics');
    await page.getByRole('button', { name: `Actions for ${emptyName}` }).click();
    await page.getByRole('menuitem', { name: 'Archive…' }).click();
    const confirm = page.getByRole('dialog', { name: `Archive ${emptyName}?` });
    await expect(confirm).toContainText(`/topics/${emptySlug} stops working`);
    await confirm.getByRole('button', { name: 'Archive topic' }).click();
    await expect(page.getByText(`Topic archived: ${emptyName}`)).toBeVisible();
    await expect(row(page, emptyName)).toHaveCount(0);
    expect(await getTopic(apiAsAdmin, emptySlug)).toBeUndefined();

    // An archived topic's edit URL says so, with a way back.
    await page.goto(`/admin/topics/${emptySlug}`);
    await expect(page.getByRole('heading', { name: 'Topic not found' })).toBeVisible();
    await page.getByRole('link', { name: 'Back to Topics' }).click();
    await expect(page).toHaveURL(/\/admin\/topics$/);
  });

  test('keeps article topic reassignment out of the editor', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const suffix = `editor-boundary-${testInfo.workerIndex}-${Date.now()}`;
    const topicName = `Editor Boundary ${suffix}`;
    const renamedTopicName = `Editor Boundary Renamed ${suffix}`;
    const topicSlug = `editor-boundary-${suffix}`;
    const title = `Topic Admin Boundary Article ${suffix}`;
    await makeTopic(apiAsAdmin, { name: topicName, slug: topicSlug });
    const created = await createPageViaApi(apiAsAdmin, {
      title,
      body: 'Article editor should not reassign topics.',
      status: 'draft',
      frontmatter: { topic: topicName },
    });

    // A rename happens on the topic's edit page, and the slug stays.
    await page.goto(`/admin/topics/${topicSlug}`);
    await page.getByRole('textbox', { name: /^Name/ }).fill(renamedTopicName);
    await page.getByRole('button', { name: 'Save topic' }).click();
    await expect(page.getByText(`Topic saved: ${renamedTopicName}`)).toBeVisible();
    await page.goto('/admin/topics');
    await expect(row(page, renamedTopicName)).toBeVisible();

    await page.goto(`/browse?q=${encodeURIComponent(renamedTopicName)}`);
    await expect(page.locator('.PageList__CardTitle').filter({ hasText: title })).toBeVisible();
    await expect(page.getByText(new RegExp(`Topic: ${renamedTopicName}`, 'i'))).toBeVisible();

    await page.goto(`/p/${created.slug}/edit`);
    const editorMain = page.locator('main');
    await expect(editorMain.getByRole('combobox', { name: /topic/i })).toHaveCount(0);
    await expect(editorMain.getByRole('textbox', { name: /topic/i })).toHaveCount(0);
    await expect(editorMain.getByRole('button', { name: /topic/i })).toHaveCount(0);
  });
});

test.describe('Topics admin on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('rows are cards with a menu, and the edit page fits the screen', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const name = `Phone Topic ${suffix}`;
    const slug = `phone-topic-${suffix}`;
    await makeTopic(apiAsAdmin, { name, slug, description: 'A description long enough to wrap on a narrow phone screen without pushing the card wider.' });

    await page.goto(`/admin/topics?q=${encodeURIComponent(name)}`);
    const card = row(page, name);
    await expect(card).toBeVisible();
    // Cards, not a sideways-scrolling table: the row fits the viewport.
    await expect.poll(async () => (await card.boundingBox())?.width ?? 9999).toBeLessThanOrEqual(390);
    await expect(card.getByRole('button', { name: `Actions for ${name}` })).toBeInViewport();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    await rowLink(page, name).click();
    await expect(page).toHaveURL(new RegExp(`/admin/topics/${slug}$`));
    await expect(page.getByRole('button', { name: 'Save topic' })).toBeInViewport();
    const editOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(editOverflow).toBeLessThanOrEqual(0);
  });
});
