/**
 * Maps to features/03-editor.feature
 *
 * Editor smoke tests. The reusable markdown-editor package owns the editing
 * internals; these tests focus on Knowledge E3 integration: edit-mode toggle,
 * WYSIWYG Markdown shortcuts, and that Save calls the server with If-Match.
 */
import { test, expect, createPageViaApi } from './fixtures.js';
import type { Page } from '@playwright/test';

function markdownEditor(page: Page) {
  return page.locator('.cm-content').first();
}

async function switchToWysiwyg(page: Page) {
  await page.getByRole('button', { name: /^Rich Text$/ }).click();
  const editor = page.locator('.me-wysiwyg-input');
  await expect(editor).toBeVisible();
  return editor;
}

async function saveFromSaveBar(page: Page) {
  await page.getByRole('region', { name: /item save status/i }).getByRole('button', { name: /^save/i }).click();
  await expect(page.getByRole('region', { name: /item save status/i })).toContainText(/saved/i, { timeout: 15_000 });
}

test.describe('editor', () => {
  test('Edit button reveals the editor surface', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Editable',
      body: 'Initial body.',
      status: 'draft',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();
    await expect(markdownEditor(signedInPage)).toBeVisible();
  });

  test('Save dispatches PUT /pages/:id with If-Match', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'SaveTest',
      body: 'before',
      status: 'draft',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // Capture the request the Save button issues
    const requestPromise = signedInPage.waitForRequest((req) =>
      req.method() === 'PUT' && req.url().includes(`/api/v1/pages/${p.id}`),
    );

    const editor = markdownEditor(signedInPage);
    await editor.click();
    await editor.press('Control+End');
    await editor.type(' — appended');

    await signedInPage.getByRole('button', { name: /save/i }).first().click();
    const req = await requestPromise;
    expect(req.headers()['if-match']).toBe(String(p.version_token));
  });

  test.skip('Frontmatter form rejects empty title on save', async () => {
    // The legacy form-style FrontmatterPanel has been replaced by the editor
    // package's property table plus Knowledge E3 metadata chrome. Keep this
    // placeholder as a searchable pointer for the old scenario name.
  });
});

/**
 * Reachability of editor block types and inline marks via the toolbar.
 * Maps to features/03-editor.feature scenario "Block types from spec §3.1 are reachable".
 *
 * The Editor exposes single-character toolbar buttons (B, I, code, Link, H1–H6,
 * •, 1., {}, ", ―) with descriptive `title` attributes — the most stable
 * locator across UX iterations is title-based.
 */
test.describe('editor — block-type reachability', () => {
  test('toolbar exposes bold, italic, inline code, link, H1-H6, both list types, code block, blockquote, hr, source toggle', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Reachable',
      body: 'a',
      status: 'draft',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();
    await switchToWysiwyg(signedInPage);

    await expect(signedInPage.getByRole('toolbar', { name: 'Rich text formatting controls' })).toBeVisible();
    await expect(signedInPage.getByTitle('Bold')).toBeVisible();
    await expect(signedInPage.getByTitle('Italic')).toBeVisible();
    await expect(signedInPage.getByTitle('Inline code')).toBeVisible();

    const blockStyle = signedInPage.getByLabel('Current block style');
    await expect(blockStyle).toBeVisible();
    for (const label of ['Paragraph', 'Heading 1', 'Heading 2', 'Heading 3', 'Quote', 'Code block']) {
      await expect(blockStyle.locator('option', { hasText: label })).toHaveCount(1);
    }

    await expect(signedInPage.getByRole('button', { name: /bulleted list/i })).toBeVisible();
    await expect(signedInPage.getByRole('button', { name: /numbered list/i })).toBeVisible();

    const insertBlock = signedInPage.getByLabel('Insert block', { exact: true });
    await expect(insertBlock).toBeVisible();
    for (const label of ['Code block', 'Table', 'Image', 'Mermaid diagram', 'PlantUML diagram']) {
      await expect(insertBlock.locator('option', { hasText: label })).toHaveCount(1);
    }

    await expect(signedInPage.getByRole('button', { name: /^Markdown$/ })).toBeVisible();
  });
});

/**
 * Markdown input rules — typing # / - / ``` ts at the start of a line should
 * transform the block, not produce literal text.
 */
test.describe('editor — markdown input rules', () => {
  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('"# " at line start becomes a heading-1 @quarantine', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, { title: `InputH1-${Date.now()}`, body: 'seed', status: 'draft' });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    const editor = await switchToWysiwyg(signedInPage);
    await editor.click();
    await signedInPage.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await signedInPage.keyboard.press('Backspace');
    await signedInPage.keyboard.type('# Heading One');

    await saveFromSaveBar(signedInPage);
    const refreshed = await apiAsAdmin.get(`/api/v1/pages/${p.id}`);
    expect(refreshed.ok()).toBeTruthy();
    const { page } = await refreshed.json();
    expect(page.body_markdown).toContain('# Heading One');
    expect(page.body_markdown).not.toContain('\\# Heading One');
  });

  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('"- " at line start becomes a bullet list @quarantine', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, { title: `InputBullet-${Date.now()}`, body: 'seed', status: 'draft' });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    const editor = await switchToWysiwyg(signedInPage);
    await editor.click();
    await signedInPage.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await signedInPage.keyboard.press('Backspace');
    await signedInPage.keyboard.type('- first item');

    await saveFromSaveBar(signedInPage);
    const refreshed = await apiAsAdmin.get(`/api/v1/pages/${p.id}`);
    expect(refreshed.ok()).toBeTruthy();
    const { page } = await refreshed.json();
    expect(page.body_markdown).toContain('- first item');
    expect(page.body_markdown).not.toContain('\\- first item');
  });
});

/**
 * Inline marks via keyboard shortcuts.
 */
test.describe('editor — keyboard shortcuts', () => {
  test('Ctrl+B bolds the selection', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, { title: 'KbBold', body: 'select me', status: 'draft' });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();
    const editor = await switchToWysiwyg(signedInPage);
    await editor.click();
    await editor.press('Control+a');
    await editor.press('Control+b');
    await expect(editor.locator('strong', { hasText: 'select me' })).toBeVisible();
  });

  test('Ctrl+I italicises the selection', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, { title: 'KbItalic', body: 'lean me', status: 'draft' });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();
    const editor = await switchToWysiwyg(signedInPage);
    await editor.click();
    await editor.press('Control+a');
    await editor.press('Control+i');
    await expect(editor.locator('em', { hasText: 'lean me' })).toBeVisible();
  });
});

/**
 * "Show source" toggle round-trips between rendered and raw views.
 */
test.describe('editor — Show source toggle', () => {
  test('toggling Show source reveals the raw Markdown textarea', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'ToggleSrc',
      body: '# A heading\n\nA paragraph.',
      status: 'draft',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();
    await switchToWysiwyg(signedInPage);

    await signedInPage.getByRole('button', { name: /^Markdown$/ }).click();
    const source = markdownEditor(signedInPage);
    await expect(source).toBeVisible();
    await expect(source).toContainText('A paragraph.');
    await expect(signedInPage.locator('.me-wysiwyg-input')).not.toBeVisible();
  });
});

/**
 * Frontmatter panel — replaced by FrontmatterStrip.
 *
 * The form-style FrontmatterPanel (title input + status <select> + tags chip
 * input + owner input + Form/Raw-YAML toggle button) was retired in favour of
 * the click-to-edit strip. The corresponding scenarios — field shape and
 * unknown-key YAML preservation — are exercised in
 * `08-frontmatter-strip.spec.ts`. The two `.skip` placeholders below remain so
 * grep against the old feature names still finds a pointer.
 */
test.describe('editor — frontmatter panel', () => {
  test.skip('form mode shows title, status (dropdown), tags, owner inputs', () => {
    // See 08-frontmatter-strip.spec.ts ›
    //   "frontmatter strip — display mode › shows title, status, tags, owner".
  });

  test.skip('Raw YAML toggle preserves unknown frontmatter keys after save', () => {
    // See 08-frontmatter-strip.spec.ts ›
    //   "frontmatter strip — YAML toggle › unknown keys round-trip".
  });
});

