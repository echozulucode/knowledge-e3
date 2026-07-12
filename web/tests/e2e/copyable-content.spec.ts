import { test, expect, createPageViaApi } from './fixtures.js';

function cardForTitle(page: import('@playwright/test').Page, title: string) {
  return page.locator('.PageList__Card').filter({ has: page.locator('.PageList__CardTitle', { hasText: title }) });
}

async function installClipboardShim(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        lastText: '',
        async writeText(text: string) {
          this.lastText = text;
        },
        async readText() {
          return this.lastText;
        },
      },
    });
  });
}

test.describe('explicit copyable content', () => {
  test('browse cards and read view expose frontmatter copy entries without summary-as-copy semantics', async ({ signedInPage, apiAsAdmin }) => {
    const item = await createPageViaApi(apiAsAdmin, {
      title: 'Deploy Runbook With Copy Blocks',
      status: 'published',
      body: [
        '## Overview',
        '',
        'This long runbook explains deployment context, rollback expectations, and references.',
        '',
        'See the release checklist and on-call notes before running the command.',
      ].join('\n'),
      frontmatter: {
        summary: 'Read this long runbook before deployment; the command is available as explicit copyable content.',
        copy: [
          { label: 'Deploy command', value: 'pnpm --filter @echozedlabs/web deploy --prod' },
          { label: 'Rollback command', value: 'pnpm --filter @echozedlabs/web rollback --last-good' },
        ],
      },
    });

    await signedInPage.goto('/');
    await installClipboardShim(signedInPage);

    const card = cardForTitle(signedInPage, 'Deploy Runbook With Copy Blocks');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator('.PageList__BriefPreview')).toContainText('Read this long runbook before deployment');
    await expect(card.getByRole('button', { name: /copy deploy command from deploy runbook with copy blocks/i })).toBeVisible();
    await expect(card.getByRole('button', { name: /copy rollback command from deploy runbook with copy blocks/i })).toBeVisible();
    await expect(card.getByRole('button', { name: /copy command from deploy runbook with copy blocks/i })).toHaveCount(0);

    await card.getByRole('button', { name: /copy deploy command from deploy runbook with copy blocks/i }).click();
    await expect(signedInPage).toHaveURL(/\/$/);
    await expect.poll(() => signedInPage.evaluate(() => navigator.clipboard.readText())).toBe('pnpm --filter @echozedlabs/web deploy --prod');

    await card.getByRole('button', { name: /copy rollback command from deploy runbook with copy blocks/i }).focus();
    await signedInPage.keyboard.press('Enter');
    await expect(signedInPage).toHaveURL(/\/$/);
    await expect.poll(() => signedInPage.evaluate(() => navigator.clipboard.readText())).toBe('pnpm --filter @echozedlabs/web rollback --last-good');

    await card.click({ position: { x: 24, y: 72 } });
    await expect(signedInPage).toHaveURL((url) => url.pathname === `/items/${item.id}`, { timeout: 10_000 });
    await installClipboardShim(signedInPage);
    await expect(signedInPage.getByRole('region', { name: /copyable content/i })).toBeVisible({ timeout: 15_000 });
    await expect(signedInPage.getByRole('button', { name: /copy deploy command/i })).toBeVisible();
    await expect(signedInPage.getByRole('button', { name: /copy rollback command/i })).toBeVisible();

    await signedInPage.getByRole('button', { name: /copy rollback command/i }).click();
    await expect.poll(() => signedInPage.evaluate(() => navigator.clipboard.readText())).toBe('pnpm --filter @echozedlabs/web rollback --last-good');
    await expect(signedInPage).toHaveURL((url) => url.pathname === `/items/${item.id}`);
  });
});
