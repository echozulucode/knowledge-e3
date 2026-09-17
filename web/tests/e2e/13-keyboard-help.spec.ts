import { test, expect, createPageViaApi } from './fixtures.js';

test.describe('keyboard help section', () => {
  /**
   * Replaces "top bar no longer shows Search" (quarantined 2026-08-13, deleted
   * 2026-09-11). That test asserted a header with NO search control at all. The
   * header kept exactly one — the ⌘K jump pill — and §3.4 keeps it there
   * deliberately while moving full-page Search to the sidebar as a route. So the
   * thing worth guarding is not absence, it is that there is still only one.
   *
   * Home plan R2.3 (2026-09-12) renamed the pill from "Jump to a page…" to
   * "Search… ⌘K": it queries the same index as `/search`, and calling one door
   * "jump" and the other "search" was one of the framings the review found.
   * The same day it became the quick search (recent searches on an empty box;
   * quick-search-recents.spec.ts). It is still the only one in the header, and
   * the home page no longer carries a search field of its own.
   */
  test('the header offers exactly one search control and Help is a normal page', async ({ signedInPage }) => {
    await signedInPage.goto('/');

    const header = signedInPage.locator('.kp-header');
    await expect(header.locator('.kp-palette-trigger')).toHaveCount(1);
    const trigger = header.getByRole('button', { name: /^search \(command or control \+ k\)$/i });
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText('Search…');
    await expect(header.getByRole('button', { name: /jump to a page/i })).toHaveCount(0);
    // Exactly one visible search control: the compact mobile twin is hidden at
    // this width, so the header never shows two doors side by side.
    await expect(header.getByRole('button', { name: /^search/i })).toHaveCount(1);

    await signedInPage.getByRole('button', { name: /^Help$/i }).click();
    await expect(signedInPage).toHaveURL(/\/help$/);

    const help = signedInPage.getByRole('region', { name: /keyboard shortcuts/i });
    await expect(help).toBeVisible();
    // Cmd/Ctrl + K is described as what it now is: the quick search.
    await expect(help).toContainText(/Cmd\/Ctrl \+ K\s*Quick search/i);
    await expect(help).toContainText(/Cmd\/Ctrl \+ S/i);
    await expect(help).toContainText(/Cmd\/Ctrl \+ Shift \+ M/i);
    await expect(help).toContainText(/Cmd\/Ctrl \+ B/i);
    await expect(help).toContainText(/Cmd\/Ctrl \+ I/i);
    await expect(signedInPage.getByRole('dialog', { name: /keyboard shortcuts/i })).toHaveCount(0);
  });

  test('Cmd+? navigates to Help instead of opening a popup', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `keyboard-help-section-${testInfo.workerIndex}-${Date.now()}`;
    const p = await createPageViaApi(apiAsAdmin, {
      title: `Keyboard Help Section ${suffix}`,
      body: 'Content.',
      status: 'draft',
    });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();

    await signedInPage.keyboard.press('Meta+Shift+/');

    await expect(signedInPage).toHaveURL(/\/help$/);
    await expect(signedInPage.getByRole('dialog', { name: /keyboard shortcuts/i })).toHaveCount(0);
    await expect(signedInPage.getByRole('heading', { name: /keyboard shortcuts/i })).toBeVisible();
  });

  test('command palette keyboard-shortcuts entry routes to Help', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `palette-help-section-${testInfo.workerIndex}-${Date.now()}`;
    const p = await createPageViaApi(apiAsAdmin, {
      title: `Command Palette Help Section ${suffix}`,
      body: 'Content.',
      status: 'draft',
    });
    await signedInPage.goto(`/p/${p.slug}`);

    await signedInPage.keyboard.press('Meta+k');
    const palette = signedInPage.locator('.kp-palette-modal');
    await expect(palette).toBeVisible({ timeout: 2000 });

    // Scoped to the palette: the quick search's empty state lists recent
    // searches first, and the entry follows them.
    const shortcutsEntry = palette.getByRole('button', { name: /keyboard shortcuts/i });
    await expect(shortcutsEntry).toBeVisible();
    await shortcutsEntry.click();

    await expect(signedInPage).toHaveURL(/\/help$/);
    await expect(signedInPage.getByRole('dialog', { name: /keyboard shortcuts/i })).toHaveCount(0);
    await expect(signedInPage.getByRole('region', { name: /keyboard shortcuts/i })).toBeVisible();
  });
});
