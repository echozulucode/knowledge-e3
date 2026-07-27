import { test, expect, createPageViaApi } from './fixtures.js';

function markdownEditor(page: import('@playwright/test').Page) {
  return page.locator('.cm-content, .ProseMirror').first();
}

test.describe('focused item editor shell', () => {
  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('labels edit mode as item editing with title, metadata, editor, and sticky save bar @quarantine', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Focused Item Shell',
      body: 'Initial body for the focused editor shell.',
      status: 'draft',
      tags: ['editor-ux'],
      frontmatter: { summary: 'Metadata should stay visible while editing.', space: 'Product workspace' },
    });

    await signedInPage.goto(`/p/${p.slug}?edit=1`);

    await expect(signedInPage.getByRole('heading', { name: /edit knowledge item/i })).toBeVisible();
    await expect(signedInPage.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Focused Item Shell');
    await expect(signedInPage.getByRole('region', { name: /item metadata/i })).toBeVisible();
    const statusChip = signedInPage.locator('.kp-item-status-chip', { hasText: 'draft' });
    await expect(statusChip).toBeVisible();
    await expect(statusChip).toHaveAttribute('aria-label', 'Item status: draft');
    await expect(signedInPage.locator('.kp-edit-metadata')).toHaveCount(0);
    await expect(markdownEditor(signedInPage)).toBeVisible();

    const saveBar = signedInPage.getByRole('region', { name: /item save status/i });
    await expect(saveBar).toBeVisible();
    await expect(saveBar.getByRole('button', { name: /^save/i })).toBeVisible();
    await expect(saveBar.getByRole('button', { name: /preview/i })).toBeVisible();
    await expect(saveBar.getByRole('button', { name: /cancel/i })).toBeVisible();
  });

  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('Ctrl+S saves from the writing area, keeps focus, and reports success in the save bar @quarantine', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Keyboard Save Shell',
      body: 'Before keyboard save.',
      status: 'draft',
    });

    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();
    const editor = markdownEditor(signedInPage);
    await editor.click();
    await editor.press('Control+End');
    await editor.type(' Saved without leaving focus.');

    const requestPromise = signedInPage.waitForRequest((req) =>
      req.method() === 'PUT' && req.url().includes(`/api/v1/pages/${p.id}`),
    );
    await editor.press('Control+S');
    await requestPromise;

    await expect(signedInPage.getByRole('region', { name: /item save status/i })).toContainText(/saved/i, { timeout: 15_000 });
    await expect(editor).toBeFocused();
  });

  test('save failures are shown next to the sticky Save action', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Visible Save Error',
      body: 'A save validation error should be near the action.',
      status: 'draft',
    });

    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();
    const title = signedInPage.getByRole('textbox', { name: 'Title', exact: true });
    await title.fill('');
    await signedInPage.getByRole('region', { name: /item save status/i }).getByRole('button', { name: /^save/i }).click();

    const saveBar = signedInPage.getByRole('region', { name: /item save status/i });
    await expect(saveBar).toContainText(/title is required/i);
  });

  test('edit mode fills the available page height with a sticky save footer', async ({ signedInPage, apiAsAdmin }) => {
    await signedInPage.setViewportSize({ width: 1280, height: 800 });
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Full Height Editor Shell',
      body: Array.from({ length: 80 }, (_, index) => `Line ${index + 1} proves editor scrolling does not cover the save footer.`).join('\n'),
      status: 'draft',
    });

    await signedInPage.goto(`/p/${p.slug}?edit=1`);

    const frame = signedInPage.locator('.kp-edit-editor-frame');
    const editorShell = signedInPage.locator('.kp-edit-editor-frame .me-editor');
    const saveBar = signedInPage.getByRole('region', { name: /item save status/i });
    await expect(frame).toBeVisible();
    await expect(editorShell).toBeVisible();
    await expect(saveBar).toBeVisible();

    const [bodyBox, titlebarBox, frameBox, editorBox, saveBarBox, framePadding] = await Promise.all([
      signedInPage.locator('.kp-pageview-body').boundingBox(),
      signedInPage.locator('.kp-edit-titlebar').boundingBox(),
      frame.boundingBox(),
      editorShell.boundingBox(),
      saveBar.boundingBox(),
      frame.evaluate((element) => {
        const style = window.getComputedStyle(element);
        return Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      }),
    ]);
    expect(bodyBox).not.toBeNull();
    expect(titlebarBox).not.toBeNull();
    expect(frameBox).not.toBeNull();
    expect(editorBox).not.toBeNull();
    expect(saveBarBox).not.toBeNull();

    const expectedFrameHeight = bodyBox!.height - titlebarBox!.height - saveBarBox!.height;
    expect(Math.abs(frameBox!.height - expectedFrameHeight)).toBeLessThanOrEqual(2);
    expect(Math.abs(frameBox!.height - framePadding - editorBox!.height)).toBeLessThanOrEqual(2);
    expect(Math.abs(saveBarBox!.y + saveBarBox!.height - bodyBox!.y - bodyBox!.height)).toBeLessThanOrEqual(2);
    expect(frameBox!.y + frameBox!.height).toBeLessThanOrEqual(saveBarBox!.y + 1);

    await signedInPage.locator('.kp-edit-editor-frame .cm-scroller').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const saveBarAfterScroll = await saveBar.boundingBox();
    expect(saveBarAfterScroll).not.toBeNull();
    expect(Math.abs(saveBarAfterScroll!.y + saveBarAfterScroll!.height - bodyBox!.y - bodyBox!.height)).toBeLessThanOrEqual(2);
  });

  // @quarantine (undiagnosed): fails against current UI; not yet triaged. Do not assume test rot — could be a real regression.
  test('wide screens do not reserve an empty right rail beside the item body @quarantine', async ({ signedInPage, apiAsAdmin }) => {
    await signedInPage.setViewportSize({ width: 1600, height: 900 });
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'Full Width Item Body',
      body: 'The item body should fill the available page surface at wide desktop widths.',
      status: 'draft',
    });

    await signedInPage.goto(`/p/${p.slug}`);

    const grid = signedInPage.locator('.kp-pageview-grid');
    const body = signedInPage.locator('.kp-pageview-body');
    await expect(grid).toBeVisible();
    await expect(body).toBeVisible();

    await expect(signedInPage.locator('.kp-pageview-rail')).toBeHidden();

    const [gridBox, bodyBox] = await Promise.all([grid.boundingBox(), body.boundingBox()]);
    expect(gridBox).not.toBeNull();
    expect(bodyBox).not.toBeNull();

    const gridRight = gridBox!.x + gridBox!.width;
    const bodyRight = bodyBox!.x + bodyBox!.width;
    expect(Math.abs(gridRight - bodyRight)).toBeLessThanOrEqual(1);
  });
});
