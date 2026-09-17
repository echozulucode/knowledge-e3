import { test, expect, createUserApiContext } from './fixtures.js';

/**
 * Maps to features/13-sources-and-review.feature — "A publish the content rules
 * refused is visible to an administrator" (plan B2, issue 98).
 *
 * Nothing is staged: the refusal is a real one. A second account creates an
 * item published in one call over REST with no description and no primary
 * category, the server refuses it with 422 `lint_failed` and records
 * `content.refused`, and the admin then reads that row on Content health and
 * follows the link into the audit log.
 */
test.describe('Admin → Health → Content: Recent refusals', () => {
  test('lists a refused publish and links to the audit log filtered to refusals', async ({
    signedInPage,
    apiAsAdmin,
    playwright,
  }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const title = `Refused Publish ${suffix}`;
    const author = await createUserApiContext(playwright, apiAsAdmin, { username: `refused-${suffix}` });
    try {
      const refused = await author.post('/api/v1/items', {
        data: { raw: `---\ntitle: ${title}\ntype: Concept\n---\nREFUSED-BODY-${suffix}\n`, status: 'published' },
      });
      expect(refused.status()).toBe(422);
      const body = await refused.json();
      expect(body.reason).toBe('lint_failed');
    } finally {
      await author.dispose();
    }

    await signedInPage.goto('/admin/health');
    const panel = signedInPage.getByRole('region', { name: 'Recent refusals' });
    await expect(panel).toBeVisible({ timeout: 15_000 });

    const row = panel.getByRole('row').filter({ hasText: title });
    await expect(row).toBeVisible();
    await expect(row).toContainText(`refused-${suffix}`);
    await expect(row).toContainText('REST API');
    await expect(row).toContainText('Create as published');
    await expect(row).toContainText('description.missing');
    await expect(row).toContainText('category.missing');
    // The rule ids, never the document.
    await expect(panel).not.toContainText(`REFUSED-BODY-${suffix}`);
    // A refused create never produced an item, so there is nothing to open.
    await expect(row.getByRole('link', { name: title })).toHaveCount(0);

    await panel.getByRole('link', { name: /all refusals in the audit log/i }).click();
    await expect(signedInPage).toHaveURL(/\/admin\/audit\?.*action=content\.refused/);
    await expect(signedInPage.getByLabel('Action', { exact: true })).toHaveValue('content.refused');
    await expect(signedInPage.getByRole('region', { name: 'Audit entries' })).toContainText('content.refused');
  });
});
