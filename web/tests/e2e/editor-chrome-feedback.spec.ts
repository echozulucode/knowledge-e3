import { expect, test, createPageViaApi } from './fixtures.js';

test.describe('editor chrome feedback', () => {
  test('existing item edit fills the available viewport and keeps Save/Cancel fixed at the bottom', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `chrome-layout-${testInfo.workerIndex}-${Date.now()}`;
    const item = await createPageViaApi(apiAsAdmin, {
      title: `Editor Layout Existing Item ${suffix}`,
      body: Array.from({ length: 20 }, (_, index) => `Line ${index + 1} for editor layout feedback.`).join('\n\n'),
      status: 'draft',
      frontmatter: { topic: 'Research', tags: ['layout'] },
    });

    await signedInPage.setViewportSize({ width: 1280, height: 720 });
    await signedInPage.goto(`/p/${item.slug}`);
    await signedInPage.getByRole('button', { name: /edit page/i }).click();

    const savebar = signedInPage.locator('.kp-edit-savebar');
    await expect(savebar.getByRole('button', { name: /^Save$/ })).toBeVisible();
    await expect(savebar.getByRole('button', { name: /^Cancel$/ })).toBeVisible();

    const layout = await signedInPage.evaluate(() => {
      const titlebar = document.querySelector('.kp-edit-titlebar')?.getBoundingClientRect();
      const editorFrame = document.querySelector('.kp-edit-editor-frame')?.getBoundingClientRect();
      const editorSurface = document.querySelector('.kp-edit-editor-frame .me-editor')?.getBoundingClientRect();
      const savebar = document.querySelector('.kp-edit-savebar')?.getBoundingClientRect();
      const savebarStyle = window.getComputedStyle(document.querySelector('.kp-edit-savebar') as Element);
      return {
        viewportHeight: window.innerHeight,
        titlebarBottom: titlebar?.bottom ?? null,
        editorTop: editorFrame?.top ?? null,
        editorBottom: editorFrame?.bottom ?? null,
        editorHeight: editorFrame?.height ?? null,
        editorSurfaceHeight: editorSurface?.height ?? null,
        savebarTop: savebar?.top ?? null,
        savebarBottom: savebar?.bottom ?? null,
        savebarPosition: savebarStyle.position,
      };
    });

    expect(layout.savebarPosition).toBe('fixed');
    expect(layout.savebarBottom).not.toBeNull();
    expect(Math.abs((layout.savebarBottom ?? 0) - layout.viewportHeight)).toBeLessThanOrEqual(2);
    expect(layout.editorTop).not.toBeNull();
    expect(layout.titlebarBottom).not.toBeNull();
    expect(Math.abs((layout.editorTop ?? 0) - (layout.titlebarBottom ?? 0))).toBeLessThanOrEqual(12);
    expect(layout.editorBottom).not.toBeNull();
    expect(layout.savebarTop).not.toBeNull();
    expect(Math.abs((layout.editorBottom ?? 0) - (layout.savebarTop ?? 0))).toBeLessThanOrEqual(2);
    expect(layout.editorHeight ?? 0).toBeGreaterThan(360);
    expect(layout.editorSurfaceHeight ?? 0).toBeGreaterThan(330);
  });

  test('existing item edit hides properties and only the bottom action bar', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `chrome-existing-${testInfo.workerIndex}-${Date.now()}`;
    const item = await createPageViaApi(apiAsAdmin, {
      title: `Editor Chrome Existing Item ${suffix}`,
      body: 'Existing item body for editor chrome feedback.',
      status: 'draft',
      frontmatter: { topic: 'Research', tags: ['feedback'] },
    });

    await signedInPage.goto(`/p/${item.slug}`);
    await signedInPage.getByRole('button', { name: /edit page/i }).click();

    await expect(signedInPage.locator('.cm-me-properties-details').first()).toHaveCount(0);
    await expect(signedInPage.getByText('Edit knowledge item')).toHaveCount(0);
    await expect(signedInPage.getByText(/Title is canonical item metadata/i)).toHaveCount(0);
    await expect(signedInPage.getByRole('button', { name: /search pages/i })).toHaveCount(0);

    const savebar = signedInPage.locator('.kp-edit-savebar');
    await expect(savebar.getByRole('button', { name: /^Save$/ })).toHaveCount(1);
    await expect(savebar.getByRole('button', { name: /^Cancel$/ })).toHaveCount(1);
    await expect(savebar.getByRole('button', { name: /preview/i })).toHaveCount(1);
    await expect(signedInPage.getByRole('button', { name: /^Save$/ })).toHaveCount(1);
    await expect(signedInPage.getByRole('button', { name: /^Cancel$/ })).toHaveCount(1);
  });

  test('new item hides properties on first edit and on later edit after save', async ({ signedInPage }, testInfo) => {
    const suffix = `chrome-new-${testInfo.workerIndex}-${Date.now()}`;
    await signedInPage.goto('/');
    await signedInPage.getByRole('button', { name: /new item/i }).first().click();

    const dialog = signedInPage.getByRole('dialog', { name: /new item composer/i });
    await dialog.getByLabel(/^title/i).fill(`Feedback New Item Properties ${suffix}`);
    await dialog.getByRole('button', { name: /start draft/i }).click();

    await expect(signedInPage).toHaveURL((url) => url.pathname.startsWith('/items/') && Boolean(url.searchParams.get('edit')), {
      timeout: 10_000,
    });
    await expect(signedInPage.locator('.cm-me-properties-details').first()).toHaveCount(0, { timeout: 15_000 });

    const savebar = signedInPage.locator('.kp-edit-savebar');
    await savebar.getByRole('button', { name: /^Save$/ }).click();
    await expect(signedInPage.locator('.kp-pageview')).toHaveAttribute('data-mode', 'read', { timeout: 10_000 });
    await expect(signedInPage.getByRole('button', { name: /edit page/i })).toBeVisible();
    await expect(signedInPage.locator('.kp-edit-savebar')).toHaveCount(0);
    await signedInPage.getByRole('button', { name: /edit page/i }).click();

    await expect(signedInPage.locator('.cm-me-properties-details').first()).toHaveCount(0, { timeout: 15_000 });
  });
});
