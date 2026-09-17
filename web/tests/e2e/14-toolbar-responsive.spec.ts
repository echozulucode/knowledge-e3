/**
 * Toolbar behaviour across viewports.
 *
 * Maps to the UX review plan §2A (WYSIWYG Toolbar Overflow at <900px).
 *
 * Rewritten 2026-09-11. The previous version was five tests built around a
 * "More" overflow button that the editor has never had; each one guarded its own
 * assertion behind `if (moreExists)` or a "best-effort" comment, so four of them
 * could not fail for any product reason and the fifth tripped Playwright's
 * strict mode — `.editor-toolbar, [role="toolbar"]` matches BOTH toolbars, and
 * they are different things:
 *
 *   - `.me-toolbar`          — "Editor controls" (mode switch, properties)
 *   - `.me-wysiwyg-toolbar`  — "Rich text formatting controls" (bold, blocks…)
 *
 * What is worth guarding is what a 375px author actually needs: both toolbars
 * present, the rich-text controls reachable, and the writing surface inside the
 * viewport rather than scrolled off the side of it. Editing lives in Compose
 * now, so these drive `/p/:slug/edit`.
 */

import { test, expect, createPageViaApi } from './fixtures.js';
import type { Page } from '@playwright/test';

const MOBILE = { width: 375, height: 667 };
const DESKTOP = { width: 1440, height: 900 };

function editorControls(page: Page) {
  return page.getByRole('toolbar', { name: 'Editor controls' });
}

function richTextControls(page: Page) {
  return page.getByRole('toolbar', { name: 'Rich text formatting controls' });
}

async function openWysiwyg(page: Page, slug: string) {
  await page.goto(`/p/${slug}/edit`);
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toBeVisible({ timeout: 15_000 });
  await editorControls(page).getByRole('button', { name: /rich text/i }).click();
  await expect(page.locator('[data-mode="wysiwyg"]')).toBeVisible({ timeout: 10_000 });
  await expect(richTextControls(page)).toBeVisible();
}

test.describe('toolbar responsive behavior', () => {
  test('both toolbars stay usable at a 375px viewport', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: `Mobile Toolbar ${testInfo.workerIndex}-${Date.now()}`,
      body: 'Content.',
      status: 'draft',
    });

    await signedInPage.setViewportSize(MOBILE);
    await openWysiwyg(signedInPage, p.slug);

    // Both toolbars are present and neither has run off the side of the screen.
    for (const toolbar of [editorControls(signedInPage), richTextControls(signedInPage)]) {
      const box = await toolbar.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE.width + 1);
    }

    // The formatting controls are reachable, not merely rendered.
    await expect(richTextControls(signedInPage).getByRole('combobox', { name: /current block style/i })).toBeVisible();
    await expect(richTextControls(signedInPage).getByRole('button').first()).toBeVisible();
  });

  test('the rich-text controls lay out inline at a 1440px viewport', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: `Desktop Toolbar ${testInfo.workerIndex}-${Date.now()}`,
      body: 'Content.',
      status: 'draft',
    });

    await signedInPage.setViewportSize(DESKTOP);
    await openWysiwyg(signedInPage, p.slug);

    const toolbar = richTextControls(signedInPage);
    const box = await toolbar.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(DESKTOP.width);

    // Inline, not stacked: the first and last control share a row.
    const buttons = toolbar.getByRole('button');
    const count = await buttons.count();
    expect(count).toBeGreaterThan(1);
    const firstBox = await buttons.first().boundingBox();
    const lastBox = await buttons.nth(count - 1).boundingBox();
    expect(firstBox).not.toBeNull();
    expect(lastBox).not.toBeNull();
    expect(Math.abs(firstBox!.y - lastBox!.y)).toBeLessThanOrEqual(4);
  });

  test('the editor survives a resize in both directions', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: `Resize Toolbar ${testInfo.workerIndex}-${Date.now()}`,
      body: 'Content to format.',
      status: 'draft',
    });

    await signedInPage.setViewportSize(MOBILE);
    await openWysiwyg(signedInPage, p.slug);

    const editor = signedInPage.locator('.me-wysiwyg-input');
    await editor.click();
    await editor.type('Hello ');
    await expect(editor).toContainText('Hello');

    await signedInPage.setViewportSize(DESKTOP);
    await expect(editor).toBeVisible();
    await expect(richTextControls(signedInPage)).toBeVisible();
    await expect(editor).toContainText('Hello');

    await signedInPage.setViewportSize(MOBILE);
    await expect(editor).toBeVisible();
    await expect(richTextControls(signedInPage)).toBeVisible();
    await expect(editor).toContainText('Hello');
  });

  test('WYSIWYG editor content stays readable at a mobile viewport', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const p = await createPageViaApi(apiAsAdmin, {
      title: `Mobile Readable ${testInfo.workerIndex}-${Date.now()}`,
      body: 'This is content for a mobile view.',
      status: 'draft',
    });

    await signedInPage.setViewportSize(MOBILE);
    await openWysiwyg(signedInPage, p.slug);

    const editor = signedInPage.locator('.me-wysiwyg-input');
    const box = await editor.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(MOBILE.width + 10);
    await expect(editor).toContainText('This is content');
  });
});
