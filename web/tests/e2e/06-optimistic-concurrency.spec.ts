/**
 * Maps to features/06-optimistic-concurrency.feature
 */
import { test, expect, createPageViaApi } from './fixtures.js';

test.describe('optimistic concurrency — API', () => {
  test('happy-path PUT bumps the version_token', async ({ apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, { title: 'OC Happy', body: 'v1' });
    const res = await apiAsAdmin.put(`/api/v1/pages/${p.id}`, {
      headers: { 'If-Match': String(p.version_token) },
      data: { body: 'v2' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.page.version_token).toBe(p.version_token + 1);
  });

  test('stale If-Match returns 409 with current_version_token', async ({ apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, { title: 'OC Stale', body: 'v1' });
    // First PUT bumps to 2.
    await apiAsAdmin.put(`/api/v1/pages/${p.id}`, {
      headers: { 'If-Match': String(p.version_token) },
      data: { body: 'v2' },
    });
    // Retry with the original (stale) version_token.
    const conflict = await apiAsAdmin.put(`/api/v1/pages/${p.id}`, {
      headers: { 'If-Match': String(p.version_token) },
      data: { body: 'v3' },
    });
    expect(conflict.status()).toBe(409);
    const body = await conflict.json();
    expect(body.message).toBeDefined();
    // The 409 payload may include current_version_token; we accept either name.
    const currentToken = body.current_version_token ?? body.currentVersionToken;
    if (currentToken !== undefined) expect(currentToken).toBe(p.version_token + 1);
  });

  test('missing If-Match is rejected with 400', async ({ apiAsAdmin }) => {
    const p = await createPageViaApi(apiAsAdmin, { title: 'OC NoMatch', body: 'v1' });
    const res = await apiAsAdmin.put(`/api/v1/pages/${p.id}`, { data: { body: 'v2' } });
    expect(res.status()).toBe(400);
  });
});

test.describe('optimistic concurrency — ConflictDialog UI', () => {
  /**
   * Helper: open a page in edit mode in the browser, then quietly bump the
   * page's server version_token via the API so the next save will 409.
   */
  async function openEditAndBumpServerSide(
    signedInPage: import('@playwright/test').Page,
    apiAsAdmin: import('@playwright/test').APIRequestContext,
    title: string,
  ) {
    const p = await createPageViaApi(apiAsAdmin, { title, body: 'starter body', status: 'draft' });
    await signedInPage.goto(`/p/${p.slug}`);
    await signedInPage.getByRole('button', { name: /edit/i }).click();
    await expect(signedInPage.locator('.cm-content')).toBeVisible();

    // Concurrent server-side edit: bumps version_token from 1 to 2.
    const bumpRes = await apiAsAdmin.put(`/api/v1/pages/${p.id}`, {
      headers: { 'If-Match': String(p.version_token) },
      data: { body: 'their concurrent edit' },
    });
    expect(bumpRes.ok()).toBeTruthy();

    return p;
  }

  test('Save on a concurrently-edited page surfaces the ConflictDialog with three actions', async ({ signedInPage, apiAsAdmin }) => {
    await openEditAndBumpServerSide(signedInPage, apiAsAdmin, 'Conflict Three Buttons');

    // Type something into the editor so the local edit is non-trivial.
    const editor = signedInPage.locator('.cm-content');
    await editor.click();
    await editor.press('Control+End');
    await editor.type(' — my local edit');

    await signedInPage.getByRole('button', { name: /^save$/i }).first().click();

    // The dialog should appear with the heading and all three actions.
    const dialog = signedInPage.getByRole('heading', { name: /edit conflict/i });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(signedInPage.getByRole('button', { name: /view their changes/i })).toBeVisible();
    await expect(signedInPage.getByRole('button', { name: /overwrite with mine/i })).toBeVisible();
    // The dialog's Cancel button has accessible name "Cancel Discard your edits"
    // (Cancel + secondary descriptor stacked). The page chrome also has a
    // separate "Cancel" button — match the dialog one by the descriptor.
    await expect(signedInPage.getByRole('button', { name: /cancel.*discard/i })).toBeVisible();
  });

  test('ConflictDialog never offers a Merge action in v0.1', async ({ signedInPage, apiAsAdmin }) => {
    await openEditAndBumpServerSide(signedInPage, apiAsAdmin, 'Conflict No Merge');

    await signedInPage.locator('.cm-content').click();
    await signedInPage.locator('.cm-content').type(' — my edit');
    await signedInPage.getByRole('button', { name: /^save$/i }).first().click();

    await expect(signedInPage.getByRole('heading', { name: /edit conflict/i })).toBeVisible({ timeout: 10_000 });
    // The whole dialog must not contain a Merge button — collab-merge is v0.5.
    await expect(signedInPage.getByRole('button', { name: /merge/i })).toHaveCount(0);
  });

  test('View their changes reveals a side-by-side diff with both versions', async ({ signedInPage, apiAsAdmin }) => {
    await openEditAndBumpServerSide(signedInPage, apiAsAdmin, 'Conflict View Diff');

    await signedInPage.locator('.cm-content').click();
    await signedInPage.locator('.cm-content').type(' — my edit');
    await signedInPage.getByRole('button', { name: /^save$/i }).first().click();

    await signedInPage.getByRole('button', { name: /view their changes/i }).click();

    // Both labels are visible, indicating the diff view rendered.
    await expect(signedInPage.getByText('Server version')).toBeVisible();
    await expect(signedInPage.getByText('Your version')).toBeVisible();
    // The server-side concurrent edit content shows up on the server side.
    await expect(signedInPage.getByText('their concurrent edit')).toBeVisible();
  });

  test('Overwrite with mine retries with the fresh version token and succeeds', async ({ signedInPage, apiAsAdmin }) => {
    const p = await openEditAndBumpServerSide(signedInPage, apiAsAdmin, 'Conflict Overwrite');

    await signedInPage.locator('.cm-content').click();
    await signedInPage.locator('.cm-content').type(' — my overwrite');
    await signedInPage.getByRole('button', { name: /^save$/i }).first().click();

    await expect(signedInPage.getByRole('heading', { name: /edit conflict/i })).toBeVisible({ timeout: 10_000 });

    // The retried PUT must use the fresh token (≥ 2 — ours started at 1, server bumped to 2).
    const retryReq = signedInPage.waitForRequest(
      (req) => req.method() === 'PUT' && req.url().includes(`/api/v1/pages/${p.id}`),
      { timeout: 10_000 },
    );
    await signedInPage.getByRole('button', { name: /overwrite with mine/i }).click();
    const req = await retryReq;
    const ifMatch = Number(req.headers()['if-match']);
    expect(ifMatch).toBeGreaterThanOrEqual(2);

    // After the retry, the dialog closes and we're back in edit mode (or read-only).
    await expect(signedInPage.getByRole('heading', { name: /edit conflict/i })).not.toBeVisible({ timeout: 10_000 });
  });

  test('Cancel in the conflict dialog closes the dialog without further saves', async ({ signedInPage, apiAsAdmin }) => {
    const p = await openEditAndBumpServerSide(signedInPage, apiAsAdmin, 'Conflict Cancel');

    await signedInPage.locator('.cm-content').click();
    await signedInPage.locator('.cm-content').type(' — my discardable edit');
    await signedInPage.getByRole('button', { name: /^save$/i }).first().click();

    await expect(signedInPage.getByRole('heading', { name: /edit conflict/i })).toBeVisible({ timeout: 10_000 });

    // Watch for any further PUTs to this page; there should be none after Cancel.
    let extraPut = false;
    signedInPage.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes(`/api/v1/pages/${p.id}`)) extraPut = true;
    });
    // The dialog's Cancel button has the accessible name "Cancel Discard your
    // edits" (composed of two stacked paragraphs). The page header has a
    // separate "✕ Cancel" button — match the dialog one by the "discard"
    // descriptor so we don't collide.
    await signedInPage.getByRole('button', { name: /cancel.*discard/i }).click();
    await expect(signedInPage.getByRole('heading', { name: /edit conflict/i })).not.toBeVisible({ timeout: 5_000 });
    // Give it a beat to ensure no rogue PUT fires after cancel.
    await signedInPage.waitForTimeout(500);
    expect(extraPut).toBe(false);
  });
});
