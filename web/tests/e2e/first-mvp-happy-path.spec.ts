import { test, expect } from './fixtures.js';

function markdownEditor(page: import('@playwright/test').Page) {
  return page.locator('.cm-content, .ProseMirror').first();
}

function cardForTitle(page: import('@playwright/test').Page, title: string) {
  return page.locator('.PageList__Card').filter({ has: page.locator('.PageList__CardTitle', { hasText: title }) });
}

test.describe('first MVP UI happy path', () => {
  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('creates, edits, saves, reloads, searches, opens result, and verifies link graph feedback @quarantine', async ({ signedInPage, apiAsAdmin }) => {
    const seededLinkedResponse = await apiAsAdmin.get(`/api/v1/pages/by-title/${encodeURIComponent('First MVP Linked Context')}`);
    expect(seededLinkedResponse.ok(), 'First-MVP seed must include the linked context item used for backlinks').toBeTruthy();
    const linked = (await seededLinkedResponse.json()).page;

    const seededAnchorResponse = await apiAsAdmin.get(`/api/v1/pages/by-title/${encodeURIComponent('First MVP Retrieval Anchor')}`);
    expect(seededAnchorResponse.ok(), 'First-MVP seed must include the retrieval anchor item used by UI and MCP smoke paths').toBeTruthy();

    const title = 'First MVP UI Happy Path';
    const editedTitle = 'First MVP UI Happy Path Edited';
    const bodyNeedle = 'first mvp ui happy path body needle';
    const editedNeedle = 'first mvp ui happy path edited body needle';

    await signedInPage.goto('/?view=all&q=first-mvp');
    await expect(cardForTitle(signedInPage, 'First MVP Retrieval Anchor'), 'Seeded retrieval anchor should be visible in the same browse/search corpus before creating a new item').toBeVisible({ timeout: 15_000 });
    await signedInPage.getByRole('button', { name: /new item/i }).first().click();

    const composer = signedInPage.getByRole('dialog', { name: /new item composer/i });
    await expect(composer).toBeVisible();
    await composer.getByLabel(/^title/i).fill(title);
    await composer.getByLabel(/space|topic/i).selectOption('Product');
    await composer.getByLabel(/primary category/i).selectOption('Research notes');
    await composer.getByLabel(/tags/i).fill('first-mvp');
    await composer.getByLabel(/tags/i).press('Enter');
    await composer.getByLabel(/groups/i).fill('agent-flow');
    await composer.getByLabel(/summary/i).fill('Automated first-MVP UI smoke summary.');
    await composer.getByLabel(/body notes/i).fill(`${bodyNeedle}. Links to [[First MVP Linked Context]].`);
    await composer.getByRole('button', { name: /start draft/i }).click();

    await expect(composer).toBeHidden({ timeout: 10_000 });
    await expect(signedInPage.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(title, { timeout: 15_000 });
    await expect(markdownEditor(signedInPage)).toContainText(bodyNeedle, { timeout: 15_000 });

    await signedInPage.getByRole('textbox', { name: 'Title', exact: true }).fill(editedTitle);
    await markdownEditor(signedInPage).press('Control+End');
    await markdownEditor(signedInPage).type(`\n\n${editedNeedle}.`);
    const saveBar = signedInPage.getByRole('region', { name: /item save status/i });
    await saveBar.getByRole('button', { name: /^Save$/ }).click();
    await expect(saveBar.getByText(/Saved|Page saved/).first()).toBeVisible({ timeout: 15_000 });

    const savedResponse = await apiAsAdmin.get(`/api/v1/pages/by-title/${encodeURIComponent(editedTitle)}`);
    expect(savedResponse.ok()).toBeTruthy();
    const saved = (await savedResponse.json()).page;
    expect(saved.body_markdown).toContain(bodyNeedle);
    expect(saved.body_markdown).toContain(editedNeedle);
    expect(saved.tags).toContain('first-mvp');
    expect(saved.categories).toContain('research-notes');
    expect(saved.groups).toContain('agent-flow');

    await signedInPage.reload();
    await expect(signedInPage.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(editedTitle, { timeout: 15_000 });
    await expect(markdownEditor(signedInPage)).toContainText(editedNeedle, { timeout: 15_000 });

    await signedInPage.goto(`/?view=all&q=${encodeURIComponent(editedNeedle)}`);
    const result = cardForTitle(signedInPage, editedTitle);
    await expect(result, 'Edited item must be searchable from the first-MVP browse path').toBeVisible({ timeout: 15_000 });
    await result.click();
    await expect(signedInPage).toHaveURL((url) => url.pathname === `/p/${saved.slug}`, { timeout: 10_000 });
    await expect(signedInPage.getByRole('heading', { name: editedTitle }).first()).toBeVisible({ timeout: 10_000 });
    await expect(signedInPage.getByRole('link', { name: 'First MVP Linked Context' }).first()).toBeVisible({ timeout: 10_000 });

    const backlinks = await (await apiAsAdmin.get(`/api/v1/pages/${linked.id}/backlinks`)).json();
    expect(backlinks.backlinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_title: editedTitle,
          target_ref: expect.stringMatching(/First MVP Linked Context|first-mvp-linked-context|page_/),
        }),
      ]),
    );
  });
});
