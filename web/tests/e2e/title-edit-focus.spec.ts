import { test, expect, createPageViaApi } from './fixtures.js';

/**
 * Typing in the title must not throw focus into the body.
 *
 * The title and the body are two documents that happen to share a screen, and
 * the sync between them (titleHeadingSync) runs on every keystroke — which is
 * exactly the kind of code that steals a caret. This guarded PageView's edit
 * shell; it now guards Compose, where the same sync runs.
 */
test.describe('item title editing focus', () => {
  test('keeps focus in the title input while typing on an existing item opened in Compose', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const page = await createPageViaApi(apiAsAdmin, {
      title: 'Focus Source Title',
      body: '# Focus Source Title\n\nBody stays editable separately.',
      status: 'draft',
    });

    await signedInPage.goto(`/p/${page.slug}/edit`);

    const titleInput = signedInPage.locator('#compose-title-input');
    await expect(titleInput).toHaveValue('Focus Source Title', { timeout: 15_000 });
    await titleInput.click();
    await titleInput.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');

    await signedInPage.keyboard.type('Focus Target Title');

    await expect(titleInput).toHaveValue('Focus Target Title');
    await expect(titleInput).toBeFocused();

    const editorBody = signedInPage.locator('.cm-content, .editor-input').first();
    await expect(editorBody).not.toBeFocused();
  });
});
