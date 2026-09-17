import { test, expect } from './fixtures.js';

/**
 * The end-to-end path a first user actually walks: find the corpus, write an
 * item, save it, reload it, find it again by what they wrote, open it, and see
 * the link graph react.
 *
 * Re-pointed 2026-09-11 after the Compose consolidation: creation moved from a
 * modal over browse to `/new`, and the item list moved from `/` to `/browse`.
 * Nothing about the journey changed — only the rooms it passes through.
 */

function markdownEditor(page: import('@playwright/test').Page) {
  return page.locator('.cm-content, .ProseMirror').first();
}

function cardForTitle(page: import('@playwright/test').Page, title: string) {
  return page.locator('.PageList__Card').filter({ has: page.locator('.PageList__CardTitle', { hasText: title }) });
}

test.describe('first MVP UI happy path', () => {
  test('creates, edits, saves, reloads, searches, opens result, and verifies link graph feedback', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const seededLinkedResponse = await apiAsAdmin.get(`/api/v1/pages/by-title/${encodeURIComponent('First MVP Linked Context')}`);
    expect(seededLinkedResponse.ok(), 'First-MVP seed must include the linked context item used for backlinks').toBeTruthy();
    const linked = (await seededLinkedResponse.json()).page;

    const seededAnchorResponse = await apiAsAdmin.get(`/api/v1/pages/by-title/${encodeURIComponent('First MVP Retrieval Anchor')}`);
    expect(seededAnchorResponse.ok(), 'First-MVP seed must include the retrieval anchor item used by UI and MCP smoke paths').toBeTruthy();

    const title = 'First MVP UI Happy Path';
    const editedTitle = 'First MVP UI Happy Path Edited';
    const bodyNeedle = 'first mvp ui happy path body needle';
    const editedNeedle = 'first mvp ui happy path edited body needle';

    await signedInPage.goto('/browse?q=first-mvp');
    await expect(
      cardForTitle(signedInPage, 'First MVP Retrieval Anchor'),
      'Seeded retrieval anchor should be visible in the same browse/search corpus before creating a new item',
    ).toBeVisible({ timeout: 15_000 });

    // Browse hands creation to Compose, seeded with the tag that was filtering.
    await signedInPage.getByRole('button', { name: /new item/i }).first().click();
    await expect(signedInPage).toHaveURL((url) => url.pathname === '/new', { timeout: 15_000 });

    const titleInput = signedInPage.getByRole('textbox', { name: 'Title', exact: true });
    await expect(titleInput).toBeVisible({ timeout: 15_000 });
    await titleInput.fill(title);
    const editor = markdownEditor(signedInPage);
    await editor.click();
    await editor.press('Control+End');
    await editor.type(`\n\n${bodyNeedle}. Links to [[First MVP Linked Context]].`);

    // Autosave turns the draft into an item and moves us onto its edit route.
    await expect(signedInPage).toHaveURL(/\/p\/[^/]+\/edit$/, { timeout: 20_000 });
    const saveBar = signedInPage.getByRole('region', { name: /item save status/i });
    await expect(saveBar).toContainText(/^Saved/, { timeout: 15_000 });

    // Rename and extend, then save explicitly.
    await titleInput.fill(editedTitle);
    await editor.press('Control+End');
    await editor.type(`\n\n${editedNeedle}.`);
    await saveBar.getByRole('button', { name: /save draft/i }).click();
    await expect(saveBar).toContainText(/^Saved/, { timeout: 15_000 });

    const savedResponse = await apiAsAdmin.get(`/api/v1/pages/by-title/${encodeURIComponent(editedTitle)}`);
    expect(savedResponse.ok()).toBeTruthy();
    const saved = (await savedResponse.json()).page;
    expect(saved.body_markdown).toContain(bodyNeedle);
    expect(saved.body_markdown).toContain(editedNeedle);

    await signedInPage.reload();
    await expect(titleInput).toHaveValue(editedTitle, { timeout: 15_000 });
    await expect(markdownEditor(signedInPage)).toContainText(editedNeedle, { timeout: 15_000 });

    // Findable by what was written into the body, not only by the title.
    await signedInPage.goto(`/browse?q=${encodeURIComponent(editedNeedle)}`);
    const result = cardForTitle(signedInPage, editedTitle);
    await expect(result, 'Edited item must be searchable from the first-MVP browse path').toBeVisible({ timeout: 15_000 });
    await result.getByRole('button', { name: new RegExp(`open ${editedTitle}`, 'i') }).focus();
    await signedInPage.keyboard.press('Enter');
    await expect(signedInPage).toHaveURL((url) => url.pathname === `/p/${saved.slug}`, { timeout: 15_000 });
    await expect(signedInPage.getByRole('heading', { name: editedTitle }).first()).toBeVisible({ timeout: 15_000 });
    await expect(signedInPage.getByRole('link', { name: 'First MVP Linked Context' }).first()).toBeVisible({ timeout: 15_000 });

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
