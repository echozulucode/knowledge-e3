import { test, expect, createPageViaApi } from './fixtures.js';

test.describe('item title editing focus', () => {
  test('keeps focus in the title input while typing on an existing item opened in edit mode', async ({
    signedInPage,
    apiAsAdmin,
  }) => {
    const page = await createPageViaApi(apiAsAdmin, {
      title: 'Focus Source Title',
      body: '# Focus Source Title\n\nBody stays editable separately.',
      status: 'draft',
    });

    await signedInPage.goto(`/p/${page.slug}?edit=1`);

    const titleInput = signedInPage.locator('#kp-edit-title-input');
    await expect(titleInput).toBeVisible();
    await titleInput.click();
    await titleInput.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');

    await signedInPage.keyboard.type('Focus Target Title');

    await expect(titleInput).toHaveValue('Focus Target Title');
    await expect(titleInput).toBeFocused();

    const editorBody = signedInPage.locator('.cm-content, .editor-input').first();
    await expect(editorBody).not.toBeFocused();
  });
});
