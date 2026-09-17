import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, createPageViaApi } from './fixtures.js';

/**
 * Admin → Tags & groups (features/21-taxonomy-admin.feature;
 * the admin UX review §4.6).
 *
 * A `Tags (N) | Groups (N)` switch kept in the URL. Tags: server search,
 * sort by usage or name, "Used by only 1 item", a usage bar, 50 a page, and no
 * dead buttons — one note says rename and merge aren't available. Groups: a
 * DataTable with Edit… and Archive… (blocked while in use), and one group
 * dialog with an "Available in" picker.
 *
 * Every test seeds its own uniquely named tags, groups and topics; the DB is
 * wiped per run, not per test.
 */

function uniqueSuffix(prefix: string, workerIndex: number): string {
  return `${prefix}${workerIndex}x${Date.now()}`;
}

async function createTopic(api: APIRequestContext, name: string): Promise<{ id: string; slug: string }> {
  const res = await api.post('/api/v1/topics', { data: { name } });
  if (!res.ok()) throw new Error(`create topic failed: ${res.status()} ${await res.text()}`);
  return (await res.json()).topic;
}

async function searchTags(page: Page, text: string) {
  await page.getByRole('searchbox', { name: 'Search tags' }).fill(text);
}

test.describe('Admin → Tags & groups: tags', () => {
  test('search, sort and the single-use filter, with no dead buttons', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const s = uniqueSuffix('tagsort', testInfo.workerIndex);
    const hot = `${s}-hot`;
    const cold = `${s}-cold`;
    for (const n of [1, 2, 3]) {
      await createPageViaApi(apiAsAdmin, { title: `Hot ${s} ${n}`, body: 'hot', tags: [hot] });
    }
    await createPageViaApi(apiAsAdmin, { title: `Cold ${s}`, body: 'cold', tags: [cold] });

    await page.goto('/admin/tags-groups');
    await expect(page.getByRole('heading', { level: 1, name: 'Tags & groups' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Tags \(\d+\)$/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Renaming and merging tags isn’t available yet.')).toBeVisible();
    // The old table carried Rename / Archive / Merge on every row, all disabled.
    await expect(page.getByRole('button', { name: /^(rename|archive|merge)$/i })).toHaveCount(0);
    // New group belongs to the Groups view.
    await expect(page.getByRole('button', { name: 'New group' })).toHaveCount(0);

    const table = page.getByRole('table', { name: 'Tags' });
    await searchTags(page, s);
    await expect(table.getByRole('row')).toHaveCount(3, { timeout: 15_000 }); // header + 2

    // Most used first by default.
    const bodyRows = table.locator('tbody tr');
    await expect(bodyRows.nth(0)).toContainText(hot);
    await expect(bodyRows.nth(0)).toContainText('3 items');
    await expect(bodyRows.nth(1)).toContainText(cold);
    await expect(bodyRows.nth(0).getByRole('link', { name: '3 items' })).toHaveAttribute('href', new RegExp(`/search\\?tag=${hot}`));

    await page.getByLabel('Sort').selectOption('name');
    await expect(bodyRows.nth(0)).toContainText(cold);

    const singleUse = page.getByRole('button', { name: 'Used by only 1 item' });
    await singleUse.click();
    await expect(singleUse).toHaveAttribute('aria-pressed', 'true');
    await expect(bodyRows).toHaveCount(1);
    await expect(bodyRows.nth(0)).toContainText(cold);

    await searchTags(page, `${s}-nothing`);
    await expect(page.getByText('No tags match')).toBeVisible({ timeout: 15_000 });
  });

  test('pages 50 tags at a time', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const s = uniqueSuffix('tagpage', testInfo.workerIndex);
    const tags = Array.from({ length: 55 }, (_, i) => `${s}-${String(i).padStart(2, '0')}`);
    await createPageViaApi(apiAsAdmin, { title: `Many tags ${s}`, body: 'many', tags });

    await page.goto('/admin/tags-groups');
    await searchTags(page, s);
    const pager = page.getByRole('navigation', { name: 'Tags pages' });
    await expect(pager).toContainText('1–50 of 55', { timeout: 15_000 });
    await expect(page.getByRole('table', { name: 'Tags' }).locator('tbody tr')).toHaveCount(50);
    await pager.getByRole('button', { name: 'Next' }).click();
    await expect(pager).toContainText('51–55 of 55');
    await expect(page.getByRole('table', { name: 'Tags' }).locator('tbody tr')).toHaveCount(5);

    // Changing what is listed or its order starts again at the first page.
    await page.getByLabel('Sort').selectOption('name');
    await expect(pager).toContainText('1–50 of 55');
  });
});

test.describe('Admin → Tags & groups: groups', () => {
  test('the view is in the URL, and a group is created and edited in one dialog', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const s = uniqueSuffix('grp', testInfo.workerIndex);
    const topicName = `Group Topic ${s}`;
    await createTopic(apiAsAdmin, topicName);
    const groupName = `Review Board ${s}`;
    const renamed = `Design Board ${s}`;

    await page.goto('/admin/tags-groups');
    await page.getByRole('tab', { name: /^Groups/ }).click();
    await expect(page).toHaveURL(/[?&]view=groups/);
    await page.reload();
    await expect(page.getByRole('tab', { name: /^Groups/ })).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('button', { name: 'New group' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New group' });
    await expect(dialog.getByRole('button', { name: 'Create group' })).toBeDisabled();
    await dialog.getByLabel(/^Name/).fill(groupName);
    await dialog.getByRole('combobox', { name: 'Available in' }).fill(topicName);
    await dialog.getByRole('option', { name: topicName }).click();
    await dialog.getByLabel('Description').fill('Signs off designs.');
    await dialog.getByRole('button', { name: 'Create group' }).click();
    await expect(dialog).toBeHidden();

    const table = page.getByRole('table', { name: 'Groups' });
    const row = table.getByRole('row', { name: new RegExp(groupName) });
    await expect(row).toContainText('Signs off designs.');
    await expect(row).toContainText(topicName);
    await expect(row).toContainText('0 items');

    // Row click opens Edit; the slug is fixed, Available in goes back to All topics.
    await row.getByRole('button', { name: new RegExp(`^${groupName}`) }).click();
    const edit = page.getByRole('dialog', { name: 'Edit group' });
    await expect(edit.getByLabel(/^Slug/)).toHaveCount(0);
    await edit.getByLabel(/^Name/).fill(renamed);
    await edit.getByRole('combobox', { name: 'Available in' }).click();
    await edit.getByRole('option', { name: 'All topics' }).click();
    await edit.getByRole('button', { name: 'Save group' }).click();
    await expect(edit).toBeHidden();

    const renamedRow = table.getByRole('row', { name: new RegExp(renamed) });
    await expect(renamedRow).toContainText('All topics');
  });

  test('archive is blocked while items are in a group and confirmed otherwise', async ({ signedInPage: page, apiAsAdmin }, testInfo) => {
    const s = uniqueSuffix('grparch', testInfo.workerIndex);
    const usedSlug = `used-${s}`;
    const unusedName = `Unused Crew ${s}`;
    await createPageViaApi(apiAsAdmin, { title: `Grouped ${s}`, body: 'in a group', frontmatter: { groups: [usedSlug] } });
    const created = await apiAsAdmin.post('/api/v1/taxonomy/groups', { data: { name: unusedName } });
    expect(created.ok()).toBe(true);

    await page.goto('/admin/tags-groups?view=groups');
    const table = page.getByRole('table', { name: 'Groups' });
    await expect(table).toBeVisible({ timeout: 15_000 });

    await table.getByRole('button', { name: `Actions for ${usedSlug}` }).click();
    const blocked = page.getByRole('menuitem', { name: 'Archive…' });
    await expect(blocked).toHaveAttribute('aria-disabled', 'true');
    await expect(blocked).toContainText('In use by 1 item');
    await page.keyboard.press('Escape');

    await table.getByRole('button', { name: `Actions for ${unusedName}` }).click();
    await page.getByRole('menuitem', { name: 'Archive…' }).click();
    const confirm = page.getByRole('dialog', { name: `Archive “${unusedName}”?` });
    await confirm.getByRole('button', { name: 'Archive group' }).click();
    await expect(confirm).toBeHidden();
    await expect(table.getByRole('row', { name: new RegExp(unusedName) })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: `Archived group “${unusedName}”` })).toBeVisible();
  });
});
