import { test, expect, createPageViaApi } from './fixtures.js';
import type { APIRequestContext } from '@playwright/test';

/**
 * Sections admin: the read-only list, the dedicated edit page, and Pinned
 * topics with its dialog (the admin UX review §4.1–4.2;
 * features/16-home-sections.feature, features/18-home-page.feature).
 *
 * Every test restores the section catalog / pin list it found, because both are
 * whole-list site config shared by the rest of the suite (the front-page specs
 * read the same lists).
 */

/** A tiny valid 1x1 PNG, the same bytes the server's image tests use. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

type Json = Record<string, unknown>;

async function getSections(api: APIRequestContext): Promise<Json[]> {
  const res = await api.get('/api/v1/sections');
  if (!res.ok()) throw new Error(`list sections failed: ${res.status()}`);
  return ((await res.json()).sections ?? []) as Json[];
}

async function putSections(api: APIRequestContext, sections: Json[]) {
  const res = await api.put('/api/v1/sections', { data: { sections } });
  if (!res.ok()) throw new Error(`save sections failed: ${res.status()} ${await res.text()}`);
}

/** An order below every existing section's, so the seeded ones sort first on the front page. */
function orderBelow(sections: Json[], offset: number): number {
  const orders = sections.map((s) => (typeof s['order'] === 'number' ? (s['order'] as number) : 0));
  return Math.min(0, ...orders) - 1000 + offset;
}

async function getPins(api: APIRequestContext): Promise<Json[]> {
  const res = await api.get('/api/v1/site/pinned');
  if (!res.ok()) throw new Error(`list pins failed: ${res.status()}`);
  return ((await res.json()).pinned ?? []) as Json[];
}

async function putPins(api: APIRequestContext, pinned: Json[]) {
  const res = await api.put('/api/v1/site/pinned', { data: { pinned } });
  if (!res.ok()) throw new Error(`save pins failed: ${res.status()} ${await res.text()}`);
}

/** The curator's own definitions back from the resolved view (the server fills cover_dark from cover). */
function pinDefs(pins: Json[]): Json[] {
  return pins.map((p) => ({
    topic: p['topic'],
    ...(p['color'] ? { color: p['color'] } : {}),
    ...(p['icon'] ? { icon: p['icon'] } : {}),
    ...(p['cover'] ? { cover: p['cover'] } : {}),
    ...(p['cover'] && p['cover_dark'] && p['cover_dark'] !== p['cover'] ? { cover_dark: p['cover_dark'] } : {}),
  }));
}

async function makeTopic(api: APIRequestContext, slug: string) {
  const res = await api.post('/api/v1/topics', { data: { name: slug, slug } });
  if (!res.ok() && res.status() !== 409) throw new Error(`seed topic failed: ${res.status()} ${await res.text()}`);
}

test.describe('Sections admin', () => {
  test('lists sections grouped by placement, with the lead and live match counts', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const before = await getSections(apiAsAdmin);
    await createPageViaApi(apiAsAdmin, { title: `Lead Item ${suffix}`, status: 'published', tags: [`e2e-lead-${suffix}`], frontmatter: { topic: 'default' } });

    try {
      await putSections(apiAsAdmin, [
        ...before,
        // Lowest order, but it matches nothing — the server drops it, so it cannot lead.
        { name: `Empty ${suffix}`, slug: `empty-${suffix}`, tags: [`e2e-none-${suffix}`], order: orderBelow(before, 0) },
        { name: `Leader ${suffix}`, slug: `leader-${suffix}`, tags: [`e2e-lead-${suffix}`], order: orderBelow(before, 10) },
        { name: `Topical ${suffix}`, slug: `topical-${suffix}`, space: 'default', order: 10 },
      ]);
      await signedInPage.goto('/admin/sections');
      await expect(signedInPage.getByRole('heading', { name: 'Sections', exact: true })).toBeVisible();

      const front = signedInPage.getByRole('region', { name: /front page/i });
      const leader = front.getByRole('row', { name: new RegExp(`Leader ${suffix}`) });
      await expect(leader).toContainText('Lead');
      await expect(leader).toContainText(`/sections/leader-${suffix}`);
      await expect(leader).toContainText('1 item');

      const empty = front.getByRole('row', { name: new RegExp(`Empty ${suffix}`) });
      await expect(empty).toContainText('0 items');
      await expect(empty.locator('[title="Hidden on the site: matches no items"]')).toBeVisible();
      await expect(empty).not.toContainText('Lead');

      // A topic's section is in that topic's group, not the front page's.
      await expect(front.getByRole('row', { name: new RegExp(`Topical ${suffix}`) })).toHaveCount(0);
      await expect(signedInPage.getByRole('region', { name: /^Topic: Default/ }).getByRole('row', { name: new RegExp(`Topical ${suffix}`) })).toBeVisible();

      // Rows are read-only: no text inputs in the list, and the name opens the edit page.
      await expect(signedInPage.locator('main.SectionsAdmin table input')).toHaveCount(0);
      await leader.getByRole('link', { name: new RegExp(`Leader ${suffix}`) }).click();
      await expect(signedInPage).toHaveURL(new RegExp(`/admin/sections/leader-${suffix}$`));
    } finally {
      await putSections(apiAsAdmin, before);
    }
  });

  test('creates a section on the edit page with pickers, and previews what it matches', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const tag = `e2e-prev-${suffix}`;
    const before = await getSections(apiAsAdmin);
    for (const n of [1, 2]) {
      await createPageViaApi(apiAsAdmin, { title: `Preview Item ${n} ${suffix}`, status: 'published', tags: [tag], frontmatter: { topic: 'default' } });
    }

    try {
      await signedInPage.goto('/admin/sections');
      await signedInPage.getByRole('link', { name: 'New section' }).first().click();
      await expect(signedInPage).toHaveURL(/\/admin\/sections\/new$/);

      await signedInPage.getByRole('textbox', { name: /^Name/ }).fill(`Preview ${suffix}`);
      // The URL follows the name on create.
      await expect(signedInPage.getByRole('textbox', { name: /^URL/ })).toHaveValue(`preview-${suffix}`);

      await signedInPage.getByRole('combobox', { name: 'Content type' }).fill('Concept');
      await signedInPage.getByRole('option', { name: 'Concept', exact: true }).click();
      await signedInPage.getByRole('combobox', { name: 'Topic' }).fill('default');
      await signedInPage.getByRole('option', { name: /^Default/ }).first().click();
      const tags = signedInPage.getByRole('combobox', { name: 'Tags' });
      await tags.fill(tag);
      await signedInPage.getByRole('option', { name: new RegExp(tag) }).first().click();
      // The chip's label, not the whole list item: the item also holds its Remove (×) button.
      await expect(signedInPage.getByRole('list', { name: 'Chosen' }).locator('.kp-picker__chipLabel')).toHaveText([tag]);
      // Backspace in the empty input removes the last chip; pick it again.
      await tags.press('Backspace');
      await expect(signedInPage.getByRole('list', { name: 'Chosen' })).toHaveCount(0);
      await tags.fill(tag);
      await tags.press('ArrowDown');
      await tags.press('Enter');

      // The preview is the site's own resolution: published, same filters.
      const preview = signedInPage.getByRole('complementary', { name: 'Preview' });
      await expect(preview.getByTestId('section-preview-count')).toHaveText('Matches 2 items · shows 2');
      await expect(preview.getByTestId('section-preview-item')).toHaveCount(2);
      await expect(preview).toContainText('Default landing');

      await signedInPage.getByRole('button', { name: 'Create section' }).click();
      await expect(signedInPage).toHaveURL(new RegExp(`/admin/sections/preview-${suffix}$`));
      await expect(signedInPage.getByText(`Section “Preview ${suffix}” saved.`)).toBeVisible();

      const saved = (await getSections(apiAsAdmin)).find((s) => s['slug'] === `preview-${suffix}`);
      expect(saved).toMatchObject({ name: `Preview ${suffix}`, type: 'Concept', space: 'default', tags: [tag] });
    } finally {
      await putSections(apiAsAdmin, before);
    }
  });

  test('blocks a URL another section already uses', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const before = await getSections(apiAsAdmin);

    try {
      await putSections(apiAsAdmin, [...before, { name: `Taken ${suffix}`, slug: `dup-${suffix}` }]);
      await signedInPage.goto('/admin/sections/new');
      await signedInPage.getByRole('textbox', { name: /^Name/ }).fill(`Dup ${suffix}`);
      await expect(signedInPage.getByText(`Another section already uses /sections/dup-${suffix}.`)).toBeVisible();
      await expect(signedInPage.getByRole('textbox', { name: /^URL/ })).toHaveAttribute('aria-invalid', 'true');

      await signedInPage.getByRole('button', { name: 'Create section' }).click();
      await expect(signedInPage.getByRole('alert').filter({ hasText: '1 field needs attention.' })).toBeVisible();
      await expect(signedInPage).toHaveURL(/\/admin\/sections\/new$/);
      expect((await getSections(apiAsAdmin)).filter((s) => String(s['slug']).startsWith(`dup-${suffix}`))).toHaveLength(1);
    } finally {
      await putSections(apiAsAdmin, before);
    }
  });

  test('reorders within a group by keyboard, with Undo', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const before = await getSections(apiAsAdmin);
    const first = `First ${suffix}`;
    const second = `Second ${suffix}`;
    const orderOf = async (slug: string) => (await getSections(apiAsAdmin)).find((s) => s['slug'] === slug)?.['order'] as number;

    try {
      await putSections(apiAsAdmin, [
        ...before,
        { name: first, slug: `first-${suffix}`, order: orderBelow(before, 0) },
        { name: second, slug: `second-${suffix}`, order: orderBelow(before, 10) },
      ]);
      await signedInPage.goto('/admin/sections');
      const handle = signedInPage.getByRole('button', { name: `Reorder ${second}` });
      await handle.focus();
      await handle.press('Space');
      await handle.press('ArrowUp');
      await handle.press('Space');

      await expect(signedInPage.getByText('Order saved.')).toBeVisible();
      await expect.poll(async () => (await orderOf(`second-${suffix}`)) < (await orderOf(`first-${suffix}`))).toBe(true);

      await signedInPage.getByRole('button', { name: 'Undo' }).last().click();
      await expect.poll(async () => (await orderOf(`first-${suffix}`)) < (await orderOf(`second-${suffix}`))).toBe(true);
    } finally {
      await putSections(apiAsAdmin, before);
    }
  });

  test('deletes a section after confirming its consequences, and Undo restores it', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const before = await getSections(apiAsAdmin);
    const name = `Doomed ${suffix}`;
    const slug = `doomed-${suffix}`;
    const has = async () => (await getSections(apiAsAdmin)).some((s) => s['slug'] === slug);

    try {
      await putSections(apiAsAdmin, [...before, { name, slug, space: 'default' }]);
      await signedInPage.goto('/admin/sections');
      await signedInPage.getByRole('button', { name: `Actions for ${name}` }).click();
      await signedInPage.getByRole('menuitem', { name: 'Delete…' }).click();

      const confirm = signedInPage.getByRole('dialog', { name: `Delete “${name}”?` });
      await expect(confirm).toContainText(`/sections/${slug} stops working`);
      await confirm.getByRole('button', { name: 'Delete section' }).click();
      await expect(confirm).toHaveCount(0);
      await expect(signedInPage.getByRole('row', { name: new RegExp(name) })).toHaveCount(0);
      await expect.poll(has).toBe(false);

      await signedInPage.getByRole('button', { name: 'Undo' }).last().click();
      await expect.poll(has).toBe(true);
      await expect(signedInPage.getByRole('row', { name: new RegExp(name) })).toBeVisible();
    } finally {
      await putSections(apiAsAdmin, before);
    }
  });
});

test.describe('Pinned topics admin', () => {
  test('pins a topic through the dialog with colour, icon and a cover from Files', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const before = await getPins(apiAsAdmin);
    const slug = `pinpick-${suffix}`;
    await makeTopic(apiAsAdmin, slug);
    const filename = `e2e-cover-${suffix}.png`;
    const upload = await apiAsAdmin.post(`/api/v1/images?filename=${encodeURIComponent(filename)}`, { headers: { 'content-type': 'image/png' }, data: PNG });
    if (!upload.ok()) throw new Error(`upload failed: ${upload.status()} ${await upload.text()}`);
    const url = (await upload.json()).url as string;

    try {
      await putPins(apiAsAdmin, []);
      await signedInPage.goto('/admin/sections/pinned');
      await expect(signedInPage.getByTestId('pinned-topics-count')).toHaveText('0 of 6');
      await signedInPage.getByRole('button', { name: 'Pin a topic' }).first().click();

      const dialog = signedInPage.getByRole('dialog', { name: 'Pin a topic' });
      await dialog.getByRole('combobox', { name: /^Topic/ }).fill(slug);
      await dialog.getByRole('option', { name: new RegExp(slug) }).click();
      await dialog.getByRole('radio', { name: 'Teal' }).check();
      await dialog.getByRole('radio', { name: 'Wrench' }).check();

      const cover = dialog.getByRole('group', { name: 'Cover', exact: true });
      // The dark theme cover waits for a cover.
      await dialog.getByText('Dark theme cover', { exact: true }).first().click();
      await expect(dialog.getByRole('group', { name: 'Dark theme cover' }).getByRole('button', { name: 'Choose from Files' })).toBeDisabled();

      await cover.getByRole('button', { name: 'Choose from Files' }).click();
      const chooser = signedInPage.getByRole('dialog', { name: 'Choose cover' });
      // Esc closes only the chooser; the pin dialog it was opened from stays open.
      await chooser.getByRole('searchbox', { name: 'Search files' }).press('Escape');
      await expect(chooser).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await cover.getByRole('button', { name: 'Choose from Files' }).click();
      await chooser.getByRole('searchbox', { name: 'Search files' }).fill(suffix);
      await chooser.getByRole('button', { name: filename }).click();
      await expect(chooser).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(cover).toContainText(url);
      await expect(dialog.getByRole('group', { name: 'Dark theme cover' }).getByRole('button', { name: 'Choose from Files' })).toBeEnabled();
      await expect(dialog.getByTestId('pin-preview-light').locator('img').first()).toHaveAttribute('src', url);

      await dialog.getByRole('button', { name: 'Pin topic' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(signedInPage.getByTestId('pinned-topics-count')).toHaveText('1 of 6');
      expect((await getPins(apiAsAdmin))[0]).toMatchObject({ topic: slug, color: 'teal', icon: 'wrench', cover: url });
    } finally {
      await putPins(apiAsAdmin, pinDefs(before));
    }
  });

  test('reorders pins by keyboard and from the menu, and unpins with Undo', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const before = await getPins(apiAsAdmin);
    const [a, b] = [`pinord-a-${suffix}`, `pinord-b-${suffix}`];
    await makeTopic(apiAsAdmin, a);
    await makeTopic(apiAsAdmin, b);
    const topics = async () => (await getPins(apiAsAdmin)).map((p) => p['topic']);

    try {
      await putPins(apiAsAdmin, [{ topic: a }, { topic: b }]);
      await signedInPage.goto('/admin/sections/pinned');

      const handle = signedInPage.getByRole('button', { name: `Reorder ${b}` });
      await handle.focus();
      await handle.press('Space');
      await handle.press('ArrowLeft');
      await handle.press('Space');
      await expect.poll(topics).toEqual([b, a]);

      await signedInPage.getByRole('button', { name: `Actions for ${b}` }).click();
      await signedInPage.getByRole('menuitem', { name: 'Move right' }).click();
      await expect.poll(topics).toEqual([a, b]);

      await signedInPage.getByRole('button', { name: `Actions for ${a}` }).click();
      await signedInPage.getByRole('menuitem', { name: 'Unpin…' }).click();
      await signedInPage.getByRole('dialog', { name: `Unpin “${a}”?` }).getByRole('button', { name: 'Unpin' }).click();
      await expect(signedInPage.getByTestId('pinned-topics-count')).toHaveText('1 of 6');
      await expect.poll(topics).toEqual([b]);

      await signedInPage.getByRole('button', { name: 'Undo' }).last().click();
      // Back where it was, first.
      await expect.poll(topics).toEqual([a, b]);
    } finally {
      await putPins(apiAsAdmin, pinDefs(before));
    }
  });

  test('stops at six pins and says why', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const before = await getPins(apiAsAdmin);
    const slugs = Array.from({ length: 6 }, (_, i) => `pinsix-${i + 1}-${suffix}`);
    for (const slug of slugs) await makeTopic(apiAsAdmin, slug);

    try {
      await putPins(apiAsAdmin, slugs.slice(0, 5).map((topic) => ({ topic })));
      await signedInPage.goto('/admin/sections/pinned');
      const pin = signedInPage.getByRole('button', { name: 'Pin a topic' }).first();
      await expect(signedInPage.getByTestId('pinned-topics-count')).toHaveText('5 of 6');
      await pin.click();
      const dialog = signedInPage.getByRole('dialog', { name: 'Pin a topic' });
      // Already-pinned topics are not offered.
      await dialog.getByRole('combobox', { name: /^Topic/ }).fill(`pinsix-1-${suffix}`);
      await expect(dialog.getByRole('option', { name: new RegExp(`pinsix-1-${suffix}`) })).toHaveCount(0);
      await dialog.getByRole('combobox', { name: /^Topic/ }).fill(slugs[5]!);
      await dialog.getByRole('option', { name: new RegExp(slugs[5]!) }).click();
      await dialog.getByRole('button', { name: 'Pin topic' }).click();
      await expect(dialog).toHaveCount(0);

      await expect(signedInPage.getByTestId('pinned-topics-count')).toHaveText('6 of 6');
      await expect(pin).toBeDisabled();
      await expect(signedInPage.getByText(/features at most 6 topics\. unpin one to pin another/i)).toBeVisible();
    } finally {
      await putPins(apiAsAdmin, pinDefs(before));
    }
  });
});
