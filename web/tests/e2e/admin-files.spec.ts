import { test, expect, createPageViaApi, type Page } from './fixtures.js';
import type { APIRequestContext } from '@playwright/test';

/**
 * Admin → Files (`/admin/images`; features/20-admin-console.feature "Files";
 * the admin UX review §4.9).
 *
 * Uploads are content-addressed, so identical bytes are ONE file shared by every
 * test that uploads them. Each test therefore uploads text files whose content
 * and name carry a per-run suffix, and filters the library by that suffix: what
 * other specs put in the shared library can never change what these assert.
 */

function suffixFor(workerIndex: number): string {
  return `${workerIndex}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

interface Uploaded {
  id: string;
  url: string;
  file: string;
}

async function uploadText(api: APIRequestContext, filename: string, content = filename): Promise<Uploaded> {
  const res = await api.post(`/api/v1/images?filename=${encodeURIComponent(filename)}`, {
    headers: { 'content-type': 'text/plain' },
    data: Buffer.from(`${content}\n`),
  });
  if (!res.ok()) throw new Error(`upload failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as Uploaded;
}

async function libraryCount(api: APIRequestContext): Promise<number> {
  const res = await api.get('/api/v1/admin/images?limit=1');
  return ((await res.json()) as { summary: { count: number } }).summary.count;
}

function card(page: Page, name: string) {
  return page.getByTestId('file-card').filter({ hasText: name });
}

test.describe('Admin → Files', () => {
  test('toolbar filters, sort and the view choice live in the URL', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const suffix = suffixFor(testInfo.workerIndex);
    await uploadText(apiAsAdmin, `notes-a-${suffix}.txt`);
    await uploadText(apiAsAdmin, `notes-b-${suffix}.txt`);

    await page.goto('/admin/images?view=grid');
    await expect(page.getByRole('heading', { level: 1, name: /^Files$/ })).toBeVisible();
    // The header carries the library totals.
    await expect(page.locator('.kp-admin-header__meta')).toContainText(/\d[\d,]* files? · /);

    const filters = page.getByRole('search', { name: 'Filter files' });
    await filters.getByLabel('Search').fill(suffix);
    await expect(page).toHaveURL(new RegExp(`[?&]q=${suffix}`));
    await expect(page.getByTestId('file-card')).toHaveCount(2);

    await filters.getByLabel('Type').selectOption('document');
    await expect(page).toHaveURL(/[?&]type=document/);
    await filters.getByLabel('Usage').selectOption('unused');
    await expect(page).toHaveURL(/[?&]usage=unused/);
    await filters.getByLabel('Sort').selectOption('name');
    await expect(page).toHaveURL(/[?&]sort=name/);
    await expect(page.getByTestId('file-card').first()).toContainText(`notes-a-${suffix}.txt`);
    // Unused is a neutral chip, not an error.
    await expect(card(page, `notes-a-${suffix}.txt`).getByTestId('file-usage')).toHaveText('Unused');

    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'List' }).click();
    await expect(page).toHaveURL(/[?&]view=list/);
    await expect(page.getByRole('table', { name: 'Files' })).toBeVisible();
    await expect(page.locator(`tr[data-row-key]`)).toHaveCount(2);

    // A reload (a shared link) restores all of it.
    await page.reload();
    await expect(page.getByRole('search', { name: 'Filter files' }).getByLabel('Type')).toHaveValue('document');
    await expect(page.getByRole('search', { name: 'Filter files' }).getByLabel('Usage')).toHaveValue('unused');
    await expect(page.getByRole('table', { name: 'Files' })).toBeVisible();

    await page.getByRole('button', { name: 'Clear filters' }).first().click();
    await expect(page).not.toHaveURL(/[?&](q|type|usage)=/);
    await expect(page).toHaveURL(/[?&]view=list/);
  });

  test('a library above 50 files opens in the list view; an explicit Grid choice sticks', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const suffix = suffixFor(testInfo.workerIndex);
    const missing = Math.max(0, 51 - (await libraryCount(apiAsAdmin)));
    for (let i = 0; i < missing; i += 1) await uploadText(apiAsAdmin, `bulk-${i}-${suffix}.txt`);
    expect(await libraryCount(apiAsAdmin)).toBeGreaterThan(50);

    await page.goto('/admin/images');
    await expect(page.getByRole('table', { name: 'Files' })).toBeVisible({ timeout: 15_000 });
    await expect(page).not.toHaveURL(/[?&]view=/);
    await expect(page.getByRole('navigation', { name: 'Files pages' })).toContainText(/1–50 of \d/);

    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Grid' }).click();
    await expect(page).toHaveURL(/[?&]view=grid/);
    await page.reload();
    await expect(page.getByTestId('files-grid')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Files' })).toHaveCount(0);
  });

  test('the detail sheet names the items that use a file, and Delete says why it is unavailable', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const suffix = suffixFor(testInfo.workerIndex);
    const name = `handout-${suffix}.txt`;
    const file = await uploadText(apiAsAdmin, name);
    const item = await createPageViaApi(apiAsAdmin, {
      title: `Uses the handout ${suffix}`,
      body: `Download the [handout](${file.url}).`,
      status: 'published',
    });

    await page.goto(`/admin/images?view=grid&q=${suffix}`);
    await expect(card(page, name).getByTestId('file-usage')).toHaveText('Used by 1 item');

    // The ⋯ menu shows the reason as text on the disabled item.
    await card(page, name).getByRole('button', { name: `Actions for ${name}` }).click();
    const del = page.getByRole('menuitem', { name: /Delete…/ });
    await expect(del).toHaveAttribute('aria-disabled', 'true');
    await expect(del).toContainText('In use by 1 item');
    await page.keyboard.press('Escape');

    await card(page, name).getByRole('button', { name: `Open details for ${name}` }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]file=${file.id}`));
    const sheet = page.getByRole('dialog', { name });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText(file.url, { exact: true })).toBeVisible();
    const usedBy = sheet.getByRole('region', { name: 'Used by' });
    const link = usedBy.getByRole('link', { name: `Uses the handout ${suffix}` });
    await expect(link).toHaveAttribute('href', `/p/${item.slug}`);
    await expect(sheet.getByTestId('file-delete-blocked')).toContainText('In use by 1 item');
    await expect(sheet.getByRole('button', { name: 'Delete…' })).toBeDisabled();

    // The sheet is a link: it opens on a fresh load too, and closing drops `file`.
    await page.reload();
    await expect(page.getByRole('dialog', { name })).toBeVisible();
    await page.getByRole('button', { name: `Close ${name}` }).click();
    await expect(page).not.toHaveURL(/[?&]file=/);

    // Each "Used by" entry is a way to the item itself.
    await page.goto(`/admin/images?view=grid&q=${suffix}&file=${file.id}`);
    await page.getByRole('dialog', { name }).getByRole('link', { name: `Uses the handout ${suffix}` }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${item.slug}$`));
  });

  test('an unused file is deleted after confirmation, with a toast', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const suffix = suffixFor(testInfo.workerIndex);
    const name = `scratch-${suffix}.txt`;
    await uploadText(apiAsAdmin, name);

    await page.goto(`/admin/images?view=grid&q=${suffix}`);
    await card(page, name).getByRole('button', { name: `Actions for ${name}` }).click();
    await page.getByRole('menuitem', { name: 'Delete…' }).click();

    const confirm = page.getByRole('dialog', { name: `Delete ${name}?` });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Delete file' }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: `Deleted ${name}.` })).toBeVisible();
    await expect(card(page, name)).toHaveCount(0);
  });

  test('uploads several files with per-file progress, and a refused file shows its reason', async ({ signedInPage: page }, testInfo) => {
    const suffix = suffixFor(testInfo.workerIndex);
    const good = `upload-ok-${suffix}.txt`;
    const bad = `upload-bad-${suffix}.exe`;

    // Hold each upload briefly so the in-flight state is observable.
    await page.route(/\/api\/v1\/images\?/, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await new Promise((r) => setTimeout(r, 700));
      await route.continue();
    });

    await page.goto('/admin/images?view=grid');
    await page.getByRole('button', { name: 'Upload' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Upload files' });
    await expect(dialog.getByRole('button', { name: 'Choose files' })).toBeVisible();
    await expect(dialog.getByTestId('files-drop-zone')).toBeVisible();

    await dialog.getByTestId('files-upload-input').setInputFiles([
      { name: good, mimeType: 'text/plain', buffer: Buffer.from(`fine ${suffix}\n`) },
      { name: bad, mimeType: 'application/x-msdownload', buffer: Buffer.from(`MZ\x90\x00 ${suffix}`) },
    ]);

    const rows = dialog.getByTestId('files-upload-row');
    await expect(rows).toHaveCount(2);
    // The first file is on the wire (with a progress bar) while the second waits.
    await expect(rows.nth(0).getByRole('progressbar', { name: `${good} upload progress` })).toBeVisible();
    await expect(rows.nth(1).getByTestId('files-upload-status')).toHaveText('Waiting');

    await expect(rows.nth(0).getByTestId('files-upload-status')).toHaveText('Uploaded', { timeout: 15_000 });
    await expect(rows.nth(1).getByTestId('files-upload-status')).toHaveText('Not uploaded', { timeout: 15_000 });
    await expect(rows.nth(1).getByRole('alert')).toContainText(/unsupported or unrecognized file type/i);

    await expect(page.getByRole('alert').filter({ hasText: 'Uploaded 1 file; 1 could not be uploaded.' })).toBeVisible();

    await dialog.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('search', { name: 'Filter files' }).getByLabel('Search').fill(suffix);
    await expect(card(page, good)).toHaveCount(1);
    await expect(card(page, bad)).toHaveCount(0);
  });

  test('on a phone the list becomes cards with actions in ⋯ and nothing scrolls sideways', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const suffix = suffixFor(testInfo.workerIndex);
    const name = `phone-${suffix}.txt`;
    await uploadText(apiAsAdmin, name);

    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/admin/images?view=list&q=${suffix}`);
    await expect(page.locator(`tr[data-row-key]`)).toHaveCount(1);
    await expect(page.locator('.kp-dt__table thead')).toBeHidden();
    const menu = page.getByRole('button', { name: `Actions for ${name}` });
    const box = await menu.boundingBox();
    expect(box, 'row menu rendered').not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    await menu.click();
    await expect(page.getByRole('menuitem', { name: 'Copy URL' })).toBeVisible();
    await page.keyboard.press('Escape');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.getByRole('button', { name: 'Upload' }).first().click();
    await expect(page.getByRole('dialog', { name: 'Upload files' }).getByRole('button', { name: 'Choose files' })).toBeVisible();
  });
});
