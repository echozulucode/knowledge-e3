import { test, expect, createPageViaApi } from './fixtures.js';

function markdownEditor(page: import('@playwright/test').Page) {
  return page.locator('.cm-content, .ProseMirror').first();
}

function cardForTitle(page: import('@playwright/test').Page, title: string) {
  return page.locator('.PageList__Card').filter({ has: page.locator('.PageList__CardTitle', { hasText: title }) });
}

async function expectOnlyOneFrontmatterEnvelope(rawMarkdown: string) {
  const envelopeMarkers = rawMarkdown.match(/^---$/gm) ?? [];
  expect(envelopeMarkers, rawMarkdown).toHaveLength(2);
  expect(rawMarkdown).not.toMatch(/---[\s\S]*---[\s\S]*---/);
}

test.describe('UI data-entry MVP smoke', () => {
  test('creates, edits, reloads, searches, and preserves draft on duplicate-title failure', async ({ signedInPage, apiAsAdmin }) => {
    const itemTitle = 'UI Data Entry Smoke Item';
    const editedTitle = 'UI Data Entry Smoke Item Updated';
    const bodyNeedle = 'mvp smoke body needle alpha';
    const editedNeedle = 'edited markdown needle beta';
    const duplicateTitle = 'UI Data Entry Duplicate Target';

    signedInPage.on('dialog', (dialog) => {
      throw new Error(`Data-entry smoke must stay in-app; saw ${dialog.type()} ${dialog.message()}`);
    });

    await createPageViaApi(apiAsAdmin, {
      title: duplicateTitle,
      body: 'Existing duplicate title target.',
      status: 'draft',
      frontmatter: { topic: 'Default topic' },
    });

    await signedInPage.goto('/?view=all&q=smoke-seed');
    await signedInPage.getByRole('button', { name: /new item/i }).first().click();

    const composer = signedInPage.getByRole('dialog', { name: /new item composer/i });
    await expect(composer).toBeVisible();
    await composer.getByLabel(/^title/i).fill(itemTitle);
    await composer.getByLabel(/space|topic/i).selectOption('Default topic');
    await composer.getByLabel(/primary category/i).selectOption('Research notes');
    await composer.getByLabel(/tags/i).fill('smoke-seed');
    await composer.getByLabel(/tags/i).press('Enter');
    await expect(composer.getByText('#smoke-seed')).toBeVisible();
    await composer.getByLabel(/groups/i).fill('Data Entry');
    await composer.getByLabel(/summary/i).fill('Manual capture smoke summary.');
    await composer.getByLabel(/body notes/i).fill(`${bodyNeedle} starts in the composer body.`);
    await composer.getByRole('button', { name: /start draft/i }).click();

    await expect(composer).toBeHidden({ timeout: 10_000 });
    await expect(signedInPage).toHaveURL((url) => url.pathname === '/p/ui-data-entry-smoke-item' && url.searchParams.has('edit'), {
      timeout: 10_000,
    });

    await expect(signedInPage.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(itemTitle, { timeout: 15_000 });
    await expect(signedInPage.getByRole('combobox', { name: /space|topic|primary category/i })).toHaveCount(0);
    await expect(signedInPage.getByRole('textbox', { name: /^tags$|^groups$/i })).toHaveCount(0);

    const editor = markdownEditor(signedInPage);
    await expect(editor).toBeFocused({ timeout: 15_000 });
    await expect(editor).toContainText(bodyNeedle);
    await editor.press('Control+End');
    await editor.type(`\n\n${editedNeedle} was added after the composer opened.`);

    const saveBar = signedInPage.getByRole('region', { name: /item save status/i });
    await saveBar.getByRole('button', { name: /^save/i }).click();
    await expect(saveBar.getByText(/^Saved/)).toBeVisible({ timeout: 15_000 });

    const createdResponse = await apiAsAdmin.get(`/api/v1/pages/by-title/${encodeURIComponent(itemTitle)}`);
    expect(createdResponse.ok()).toBeTruthy();
    const createdBody = await createdResponse.json();
    const createdItem = createdBody.page;
    expect(createdItem.frontmatter.topic).toBe('Default topic');
    expect(createdItem.categories).toContain('research-notes');
    expect(createdItem.tags).toContain('smoke-seed');
    expect(createdItem.groups).toContain('data-entry');
    expect(createdItem.body_markdown).toContain(bodyNeedle);
    expect(createdItem.body_markdown).toContain(editedNeedle);
    await expectOnlyOneFrontmatterEnvelope(createdItem.raw_markdown);

    await signedInPage.reload();
    await expect(signedInPage.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(itemTitle, { timeout: 15_000 });
    await expect(markdownEditor(signedInPage)).toContainText(editedNeedle, { timeout: 15_000 });

    await signedInPage.getByRole('textbox', { name: 'Title', exact: true }).fill(editedTitle);
    await markdownEditor(signedInPage).press('Control+End');
    await markdownEditor(signedInPage).type('\n\nSecond save after reload remains clean.');
    await saveBar.getByRole('button', { name: /^save/i }).click();
    await expect(saveBar.getByText(/^Saved/)).toBeVisible({ timeout: 15_000 });

    const editedResponse = await apiAsAdmin.get(`/api/v1/pages/${createdItem.id}`);
    expect(editedResponse.ok()).toBeTruthy();
    const editedBody = await editedResponse.json();
    expect(editedBody.page.title).toBe(editedTitle);
    expect(editedBody.page.body_markdown).toContain(editedNeedle);
    expect(editedBody.page.body_markdown).toContain('Second save after reload remains clean.');
    expect(editedBody.page.raw_markdown).toContain('tags:');
    expect(editedBody.page.raw_markdown).toContain('smoke-seed');
    await expectOnlyOneFrontmatterEnvelope(editedBody.page.raw_markdown);

    const browseChecks = [
      { label: 'title', url: `/?view=all&q=${encodeURIComponent(editedTitle)}` },
      { label: 'body', url: `/?view=all&q=${encodeURIComponent(editedNeedle)}` },
      { label: 'topic', url: '/?view=all&topic=Default%20topic' },
      { label: 'category', url: '/?view=all&category=research-notes' },
      { label: 'tag', url: '/?view=all&tag=smoke-seed' },
    ];

    for (const check of browseChecks) {
      await signedInPage.goto(check.url);
      const card = cardForTitle(signedInPage, editedTitle);
      await expect(card, `Expected item to be browsable by ${check.label}`).toBeVisible({ timeout: 15_000 });
    }

    await signedInPage.goto(`/p/${editedBody.page.slug}?edit=1`);
    await signedInPage.getByRole('textbox', { name: 'Title', exact: true }).fill(duplicateTitle);
    const duplicateDraftText = 'duplicate failure must keep this draft body';
    await markdownEditor(signedInPage).press('Control+End');
    await markdownEditor(signedInPage).type(`\n\n${duplicateDraftText}`);
    await saveBar.getByRole('button', { name: /^save/i }).click();

    await expect(saveBar).toContainText(/already exists in this (topic|space)/i, { timeout: 15_000 });
    await expect(signedInPage.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(duplicateTitle);
    await expect(markdownEditor(signedInPage)).toContainText(duplicateDraftText);

    const afterDuplicateResponse = await apiAsAdmin.get(`/api/v1/pages/${createdItem.id}`);
    expect(afterDuplicateResponse.ok()).toBeTruthy();
    const afterDuplicate = await afterDuplicateResponse.json();
    expect(afterDuplicate.page.title).toBe(editedTitle);
    expect(afterDuplicate.page.body_markdown).not.toContain(duplicateDraftText);
    await expectOnlyOneFrontmatterEnvelope(afterDuplicate.page.raw_markdown);
  });
});
