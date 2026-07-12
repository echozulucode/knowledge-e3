/**
 * Frontmatter Strip tests — Confluence-style metadata strip (Style B).
 *
 * NOTE: ENTIRE SUITE CURRENTLY SKIPPED.
 *
 * The strip is now gated on `editorMode === 'wysiwyg'` in PageView (only the
 * new CM6/Lexical editor has a WYSIWYG mode; in hybrid/preview modes the
 * frontmatter is rendered inline in the editor surface). The Playwright
 * suite is pinned to the legacy Tiptap editor via
 * `VITE_NEW_EDITOR=false` in playwright.config.ts because the existing
 * 03-editor specs assert against `.ProseMirror` (Tiptap) DOM. Until those
 * specs are rewritten against the new editor's CM6/Lexical DOM AND a setup
 * step flips the editor into WYSIWYG mode, the strip is unreachable from
 * here and every assertion below times out.
 *
 * To re-enable: drop `VITE_NEW_EDITOR=false` from playwright.config.ts,
 * rewrite 03-editor.spec.ts against the new editor's DOM, and add a
 * `getByRole('button', { name: /wysiwyg/i }).click()` step to each test
 * before asserting strip behaviour.
 */

import { test, expect, createPageViaApi } from './fixtures.js';

test.describe.configure({ mode: 'serial' });
test.skip(true, 'Strip is WYSIWYG-only; e2e suite is pinned to legacy editor. See file header.');

test.describe('frontmatter strip — display mode', () => {
  test('shows title, status, tags, owner, and updated timestamp in read-only mode', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Test Page',
      status: 'published',
      tags: ['runbook', 'oncall'],
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // Anchor each assertion on the stable per-field title attribute so we
    // never collide with the page H1 or breadcrumb that also contain the
    // title text.
    await expect(signedInPage.getByTitle('Click to edit title')).toContainText('Test Page');
    await expect(signedInPage.getByTitle('Click to edit status')).toContainText(/published/i);
    // Tags render joined with ", " in the read-mode chip.
    const tagsField = signedInPage.getByTitle('Click to edit tags');
    await expect(tagsField).toContainText('runbook');
    await expect(tagsField).toContainText('oncall');
  });

  test('shows status icon (green for published, grey for draft)', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const draft = await createPageViaApi(apiAsAdmin, {
      title: 'Draft Page',
      status: 'draft',
      body: 'draft content',
    });
    const published = await createPageViaApi(apiAsAdmin, {
      title: 'Published Page',
      status: 'published',
      body: 'published content',
    });

    await signedInPage.goto(`/p/${draft.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();
    await expect(signedInPage.getByTitle('Click to edit status')).toContainText(/draft/i);

    await signedInPage.goto(`/p/${published.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();
    await expect(signedInPage.getByTitle('Click to edit status')).toContainText(/published/i);
  });

  test('displays relative date for updated_at field', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Recent Page',
      status: 'draft',
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();
    // Newly-created page → relative date shows "today".
    await expect(signedInPage.getByText(/today|ago|yesterday/i).first()).toBeVisible();
  });
});

test.describe('frontmatter strip — title click-to-edit', () => {
  test('clicking title field enters inline edit mode', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Original Title',
      status: 'draft',
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    await signedInPage.getByTitle('Click to edit title').click();
    // The strip auto-focuses the inline input on click. `:focus` is a
    // stronger signal than a value-based filter (which doesn't work on
    // <input> — value isn't text content).
    const titleInput = signedInPage.locator('input[type="text"]:focus');
    await expect(titleInput).toBeVisible();
    await expect(titleInput).toHaveValue('Original Title');
  });

  test('pressing Enter commits title change', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Original',
      status: 'draft',
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    await signedInPage.getByTitle('Click to edit title').click();
    const titleInput = signedInPage.locator('input[type="text"]:focus');
    await titleInput.fill('New Title');
    await titleInput.press('Enter');

    // Strip returns to display mode with the new title rendered in the field.
    await expect(signedInPage.getByTitle('Click to edit title')).toContainText('New Title');
  });

  test('pressing Esc cancels title edit', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Keep This',
      status: 'draft',
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    await signedInPage.getByTitle('Click to edit title').click();
    const titleInput = signedInPage.locator('input[type="text"]:focus');
    await titleInput.fill('Should Not Save');
    await titleInput.press('Escape');

    // Field reverts; the strip still shows the original.
    await expect(signedInPage.getByTitle('Click to edit title')).toContainText('Keep This');
    await expect(signedInPage.getByTitle('Click to edit title')).not.toContainText('Should Not Save');
  });

  test('empty title is rejected with inline error', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Has Title',
      status: 'draft',
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    await signedInPage.getByTitle('Click to edit title').click();
    const titleInput = signedInPage.locator('input[type="text"]:focus');
    await titleInput.fill('');
    await titleInput.press('Enter');

    // The strip surfaces the validation message inline.
    await expect(signedInPage.getByText(/cannot be empty|required/i).first()).toBeVisible();
  });

  test('title exceeding 500 chars is rejected', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Valid Title',
      status: 'draft',
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    await signedInPage.getByTitle('Click to edit title').click();
    const titleInput = signedInPage.locator('input[type="text"]:focus');
    // `.fill()` is far faster than `.type()` for a 501-char string and still
    // exercises the same validation path (the strip validates on commit, not
    // on keystroke).
    await titleInput.fill('x'.repeat(501));
    await titleInput.press('Enter');

    await expect(signedInPage.getByText(/exceed 500|too long/i).first()).toBeVisible();
  });
});

test.describe('frontmatter strip — status click-to-edit', () => {
  test('clicking status field opens popover (not a select)', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Status Test',
      status: 'draft',
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    await signedInPage.getByTitle('Click to edit status').click();

    // Both options should appear as buttons inside the popover. Match by
    // role+name to avoid the strict-mode collision with the strip's display
    // chip (which also says "draft").
    await expect(signedInPage.getByRole('button', { name: /^draft/i })).toBeVisible();
    await expect(signedInPage.getByRole('button', { name: /^published/i })).toBeVisible();
    // No <select> anywhere — this is a popover, not a form control.
    await expect(signedInPage.locator('select')).toHaveCount(0);
  });

  test('selecting published from popover updates status', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Draft Page',
      status: 'draft',
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    await signedInPage.getByTitle('Click to edit status').click();
    await signedInPage.getByRole('button', { name: /^published/i }).click();

    await expect(signedInPage.getByTitle('Click to edit status')).toContainText(/published/i);
    await expect(signedInPage.getByTitle('Click to edit status')).not.toContainText(/draft/i);
  });

  test('pressing Esc closes status popover without change', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Draft Page',
      status: 'draft',
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    await signedInPage.getByTitle('Click to edit status').click();
    // Wait for the popover to actually mount before pressing Esc — the test
    // can outrun React's render and fire the keystroke while the strip's
    // data-strip-active attribute is still 'false', allowing PageView's
    // window-level Esc handler to exit edit mode entirely.
    await expect(signedInPage.getByRole('button', { name: /^draft/i })).toBeVisible();
    await signedInPage.keyboard.press('Escape');

    await expect(signedInPage.getByTitle('Click to edit status')).toContainText(/draft/i);
  });
});

test.describe('frontmatter strip — tags click-to-edit', () => {
  test('clicking tags field enters chip editor', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Tags Test',
      status: 'draft',
      tags: ['existing', 'extra'],
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    await signedInPage.getByTitle('Click to edit tags').click();

    // The chip editor renders existing tags as removable chips and shows an
    // input. The placeholder switches between "add tags..." (when empty) and
    // "" (when there are tags), so we match the focused input directly.
    const input = signedInPage.locator('input[type="text"]:focus');
    await expect(input).toBeVisible();
    // Both chips present — assert via text inside the focused chip editor's
    // parent container. The chips' span text is exact.
    await expect(signedInPage.locator('span').filter({ hasText: /^existing$/ }).first()).toBeVisible();
    await expect(signedInPage.locator('span').filter({ hasText: /^extra$/ }).first()).toBeVisible();
  });

  test('typing a new tag and pressing Enter adds it', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Tags Add Test',
      status: 'draft',
      tags: ['existing'],
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    await signedInPage.getByTitle('Click to edit tags').click();
    const input = signedInPage.locator('input[type="text"]:focus');
    await input.fill('newtag');
    await input.press('Enter');

    await expect(signedInPage.locator('span').filter({ hasText: /^existing$/ }).first()).toBeVisible();
    await expect(signedInPage.locator('span').filter({ hasText: /^newtag$/ }).first()).toBeVisible();
  });

  test('clicking × removes a tag', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Tags Remove Test',
      status: 'draft',
      tags: ['keep', 'remove'],
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    await signedInPage.getByTitle('Click to edit tags').click();

    // Each chip's × is a button. The chip editor renders chips in tag order,
    // so the second × button removes "remove".
    const closeButtons = signedInPage.getByRole('button', { name: '×' });
    await closeButtons.nth(1).click();

    await expect(signedInPage.locator('span').filter({ hasText: /^keep$/ }).first()).toBeVisible();
    await expect(signedInPage.locator('span').filter({ hasText: /^remove$/ })).toHaveCount(0);
  });

  test('pressing Esc in tags editor cancels new entry', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Tags Esc Test',
      status: 'draft',
      tags: ['initial'],
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    await signedInPage.getByTitle('Click to edit tags').click();
    const input = signedInPage.locator('input[type="text"]:focus');
    await input.fill('temp');
    await input.press('Escape');

    // Esc cancels — "temp" was only in the unconfirmed input buffer, not a
    // committed chip. The original tag survives.
    await expect(signedInPage.getByTitle('Click to edit tags')).toContainText('initial');
    await expect(signedInPage.locator('span').filter({ hasText: /^temp$/ })).toHaveCount(0);
  });
});

test.describe('frontmatter strip — owner click-to-edit', () => {
  test('owner field is hidden when unset and revealed via raw YAML', async ({ signedInPage, apiAsAdmin }) => {
    // The strip's display mode hides the owner pill when owner is unset
    // (Fields.tsx renders `null` in that case). The owner-edit affordance
    // becomes reachable only after the user populates owner via raw YAML.
    // For now we just assert the expected display behaviour.
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Owner Test',
      status: 'draft',
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // No owner field present until set.
    await expect(signedInPage.getByTitle('Click to edit owner')).toHaveCount(0);
  });
});

test.describe('frontmatter strip — raw YAML toggle', () => {
  /**
   * The strip's "⋯" overflow button has title="Show raw YAML"; using that as
   * the locator avoids fragile emoji-text matching.
   */
  async function openYamlEditor(signedInPage: import('@playwright/test').Page) {
    await signedInPage.getByTitle('Show raw YAML').click();
    const yamlBox = signedInPage.locator('textarea').first();
    await expect(yamlBox).toBeVisible();
    return yamlBox;
  }

  test('"Show YAML" button reveals raw YAML editor', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'YAML Test',
      status: 'published',
      tags: ['test'],
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();
    await openYamlEditor(signedInPage);
  });

  test('raw YAML reflects current frontmatter', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'YAML Content Test',
      status: 'draft',
      tags: ['foo', 'bar'],
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();
    const yamlBox = await openYamlEditor(signedInPage);

    const yamlText = await yamlBox.inputValue();
    expect(yamlText).toContain('YAML Content Test');
    expect(yamlText).toContain('draft');
    expect(yamlText).toContain('foo');
  });

  test('auto-maintained fields are noted at the bottom of YAML mode', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Auto Fields Test',
      status: 'draft',
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();
    await openYamlEditor(signedInPage);

    await expect(signedInPage.getByText(/auto-maintained/i)).toBeVisible();
  });

  test('invalid YAML in raw editor shows error', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'YAML Error Test',
      status: 'draft',
      body: 'content',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();
    const yamlBox = await openYamlEditor(signedInPage);

    await yamlBox.fill('invalid: yaml: content:');
    await expect(signedInPage.getByText(/invalid yaml/i).first()).toBeVisible();
  });
});
