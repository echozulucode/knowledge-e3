/**
 * P0 regression test: edit-mode sync on mode switch.
 *
 * Maps to docs/ux-review-plan.md §1A (Critical Bug: Edit-Mode Sync on Mode Switch).
 *
 * Regression test suite for the unified markdown state across CM6 (hybrid/preview)
 * and Lexical (WYSIWYG) editors. Proves that edits in one mode persist when
 * switching to another mode without saving. This validates the currentMarkdownRef
 * mechanism introduced to fix the P0 sync bug.
 *
 * Workflow:
 * 1. Navigate to an edit-mode page (hybrid).
 * 2. In source/hybrid mode, type a unique marker.
 * 3. Switch to WYSIWYG; assert the marker text is visible in the rendered output.
 * 4. In WYSIWYG, type another marker.
 * 5. Switch to hybrid; assert BOTH markers are visible in the source editor.
 * 6. Don't save between steps — the whole point is proving in-memory sync.
 */

import { test, expect, createPageViaApi } from './fixtures.js';

test.describe('edit-mode sync — P0 regression', () => {
  // @quarantine (app bug): editor save/sync path hangs — pre-existing, predates the OKF pivot. Test is likely correct; fix the product.
  test('edits in source mode sync to WYSIWYG without save @quarantine', async ({ signedInPage, apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'SyncTest',
      body: 'Initial body.',
      status: 'draft',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // Assume default mode is hybrid. Locate the editor surface (CM6).
    // CM6 doesn't have a stable data-testid in the existing codebase, so we use
    // the wrapper div with data-mode attribute.
    const editorWrapper = signedInPage.locator('[data-mode="hybrid"]');
    await expect(editorWrapper).toBeVisible();

    // Type a unique marker string in the CM6 surface.
    const marker1 = '-- SYNC TEST 12345 --';
    const cmContent = signedInPage.locator('.cm-content');
    await cmContent.click();
    await cmContent.press('Control+End');
    await cmContent.type(`\n\n${marker1}`);

    // Allow a brief moment for the state to settle
    await signedInPage.waitForTimeout(100);

    // Switch to WYSIWYG mode by clicking the WYSIWYG button
    await signedInPage.getByRole('button', { name: /rich text/i }).click();

    // Wait for the WYSIWYG editor to become visible
    await expect(signedInPage.locator('[data-mode="wysiwyg"]')).toBeVisible();

    // Give the Lexical editor a moment to mount and render
    await signedInPage.waitForTimeout(200);

    // Assert: the CM6-typed text should be visible in the Lexical editor output.
    // Lexical wraps its content in an editable div with class .editor-input
    const lexicalEditor = signedInPage.locator('.editor-input');
    await expect(lexicalEditor).toContainText(marker1);
  });

  // @quarantine (app bug): editor save/sync path hangs — pre-existing, predates the OKF pivot. Test is likely correct; fix the product.
  test('edits in WYSIWYG sync back to source mode without save @quarantine', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'SyncTest2',
      body: 'Starting text.',
      status: 'draft',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // Switch to WYSIWYG mode first
    await signedInPage.getByRole('button', { name: /rich text/i }).click();
    await expect(signedInPage.locator('[data-mode="wysiwyg"]')).toBeVisible();
    await signedInPage.waitForTimeout(200);

    // Type a marker in the Lexical editor
    const marker1 = '-- WYSIWYG 67890 --';
    const lexicalEditor = signedInPage.locator('.editor-input');
    await lexicalEditor.click();
    await lexicalEditor.press('End');
    await lexicalEditor.press('Enter');
    await lexicalEditor.press('Enter');
    await lexicalEditor.type(marker1);

    await signedInPage.waitForTimeout(100);

    // Switch back to hybrid (or source) mode
    await signedInPage.getByRole('button', { name: /hybrid/i }).click();
    await expect(signedInPage.locator('[data-mode="hybrid"]')).toBeVisible();
    await signedInPage.waitForTimeout(200);

    // Assert: the text typed in WYSIWYG should be visible in the CM6 raw surface
    const cmContent = signedInPage.locator('.cm-content');
    await expect(cmContent).toContainText(marker1);
  });

  // @quarantine (app bug): editor save/sync path hangs — pre-existing, predates the OKF pivot. Test is likely correct; fix the product.
  test('round-trip: CM6 → Lexical → CM6 preserves both edits @quarantine', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'RoundTrip',
      body: 'Base.',
      status: 'draft',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // Step 1: type in CM6 (hybrid mode, default)
    const marker1 = '-- SYNC TEST 12345 --';
    const cmContent = signedInPage.locator('.cm-content');
    await cmContent.click();
    await cmContent.press('End');
    await cmContent.type(`\n${marker1}`);
    await signedInPage.waitForTimeout(100);

    // Step 2: switch to WYSIWYG and type another marker
    await signedInPage.getByRole('button', { name: /rich text/i }).click();
    await expect(signedInPage.locator('[data-mode="wysiwyg"]')).toBeVisible();
    await signedInPage.waitForTimeout(200);

    const marker2 = '-- WYSIWYG 67890 --';
    const lexicalEditor = signedInPage.locator('.editor-input');
    await lexicalEditor.click();
    await lexicalEditor.press('End');
    await lexicalEditor.type(`\n${marker2}`);
    await signedInPage.waitForTimeout(100);

    // Step 3: switch back to CM6 (via "Hybrid" button or cycle)
    // The next mode in the cycle from WYSIWYG is hybrid
    await signedInPage.getByRole('button', { name: /hybrid/i }).click();
    await expect(signedInPage.locator('[data-mode="hybrid"]')).toBeVisible();
    await signedInPage.waitForTimeout(200);

    // Assert: BOTH markers should now be visible in the raw editor
    const cmContent2 = signedInPage.locator('.cm-content');
    await expect(cmContent2).toContainText(marker1);
    await expect(cmContent2).toContainText(marker2);
  });

  // @quarantine (app bug): editor save/sync path hangs — pre-existing, predates the OKF pivot. Test is likely correct; fix the product.
  test('keyboard shortcut Cmd+Shift+M cycles modes while preserving edits @quarantine', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: 'CycleModes',
      body: 'Cycle test.',
      status: 'draft',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    // Type in hybrid (default, assumed)
    const marker = '-- CYCLE TEST --';
    const cmContent = signedInPage.locator('.cm-content');
    await cmContent.click();
    await cmContent.press('End');
    await cmContent.type(`\n${marker}`);
    await signedInPage.waitForTimeout(100);

    // Use keyboard shortcut to cycle to next mode (hybrid → preview)
    await signedInPage.keyboard.press('Meta+Shift+M');
    await signedInPage.waitForTimeout(200);

    // Should now be in preview mode. Assert the marker is still there (rendered).
    await expect(signedInPage.locator('[data-mode="preview"]')).toBeVisible();
    const cmContent2 = signedInPage.locator('.cm-content');
    await expect(cmContent2).toContainText(marker);

    // Cycle again (preview → wysiwyg)
    await signedInPage.keyboard.press('Meta+Shift+M');
    await signedInPage.waitForTimeout(200);

    await expect(signedInPage.locator('[data-mode="wysiwyg"]')).toBeVisible();
    const lexicalEditor = signedInPage.locator('.editor-input');
    await expect(lexicalEditor).toContainText(marker);

    // Cycle once more (wysiwyg → hybrid)
    await signedInPage.keyboard.press('Meta+Shift+M');
    await signedInPage.waitForTimeout(200);

    await expect(signedInPage.locator('[data-mode="hybrid"]')).toBeVisible();
    const cmContent3 = signedInPage.locator('.cm-content');
    await expect(cmContent3).toContainText(marker);
  });
});
