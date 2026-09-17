import { readFile } from 'node:fs/promises';
import { test, expect, createPageViaApi } from './fixtures.js';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * Maps to features/15-okf-data-bridge.feature.
 *
 * Admin → Data (`/admin/data`) is the only surface that makes the "your content
 * is yours" promise operable without a shell. The round-trip is the point: an
 * export that cannot be imported back is a backup that is not a backup, and the
 * failure is silent — the file downloads either way.
 *
 * Every export here is scoped to a topic created by the test, so the assertions
 * are about a bundle whose exact contents the test knows.
 *
 * The page (the admin UX review §4.9) is three tabs in the URL —
 * Import · Export · Audit (`?tab=`). Import is a Choose → Review → Import
 * stepper in one card: choosing a bundle runs `POST /okf/validate*` and moves to
 * Review with the three-tier report; Continue is enabled only when conformant;
 * the Import step states what Import writes, and the outcome lands in the same card.
 *
 * Selectors the page exposes:
 *   - tabs "Import", "Export", "Audit" (tablist "Data views")
 *   - Import: hidden file inputs labelled "Bundle file" / "Bundle folder" behind
 *     buttons "Choose file…" / "Choose folder…"; `[data-step]` on the card;
 *     `.OkfAdmin__importStatus` (role=status); `[data-testid=would-change]`;
 *     buttons "Continue", "Import" (exact), "Choose a different bundle";
 *     `[data-testid=import-statement]`; `[data-report="validation"|"refusal"]`
 *   - Export: select "Export topic", radios ".tar.gz archive" / ".json envelope", button "Download"
 *   - Audit: select "Audit topic", `[data-testid=audit-verdict]`, `[data-tier]` sections, `details[data-rule]`
 */

interface OkfBundle {
  okf_version: string;
  item_count: number;
  conformance: { conformant: boolean };
  files: { path: string; content: string }[];
}

interface BundleFile {
  path: string;
  content: string;
}

/** A topic of our own, so an export scoped to it holds only what we put there. */
async function seedSpace(api: APIRequestContext, suffix: string): Promise<{ slug: string; name: string }> {
  const slug = `okf-${suffix}`;
  const name = `OKF Bundle ${suffix}`;
  const res = await api.post('/api/v1/topics', {
    data: { name, slug, description: 'Exported and re-imported by the OKF data bridge e2e.' },
  });
  if (!res.ok()) throw new Error(`seed topic failed: ${res.status()} ${await res.text()}`);
  return { slug, name };
}

function card(page: Page, name: 'Import' | 'Export' | 'Library audit') {
  return page.getByRole('region', { name, exact: true });
}

function importStatus(page: Page) {
  return page.locator('.OkfAdmin__importStatus');
}

function importButton(page: Page) {
  return page.getByRole('button', { name: 'Import', exact: true });
}

function slugOf(title: string): string {
  return title.toLowerCase().replace(/\s+/g, '-');
}

/** Valid OKF that meets this instance's policy: typed, described, one primary category. */
function goodConcept(title: string): BundleFile {
  return {
    path: `concepts/${slugOf(title)}.md`,
    content: ['---', 'type: Concept', `title: ${title}`, 'description: Imported by the OKF admin e2e.', 'categories:', '  - research-notes', '---', '', `Body of ${title}.`, ''].join('\n'),
  };
}

/** Valid OKF below policy — published with no description and no category. Imports, flagged. */
function belowStandardConcept(title: string): BundleFile {
  return {
    path: `concepts/${slugOf(title)}.md`,
    content: ['---', 'type: Concept', `title: ${title}`, 'e3_status: published', '---', '', 'Body.', ''].join('\n'),
  };
}

/** Not OKF: no `type` — a critical conformance issue the import gate refuses. */
function untypedConcept(title: string): BundleFile {
  return {
    path: `concepts/${slugOf(title)}.md`,
    content: ['---', `title: ${title}`, 'description: Not a concept.', '---', '', 'Body.', ''].join('\n'),
  };
}

/** Choose a `{ files }` envelope through the drop zone's file input. */
async function chooseJsonBundle(page: Page, name: string, files: BundleFile[]): Promise<void> {
  await page.getByLabel('Bundle file', { exact: true }).setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ files })),
  });
}

/**
 * Choose a downloaded bundle. A download's temp path has no extension, and the
 * drop zone tells an archive from a JSON file by name, so the suggested name travels with the bytes.
 */
async function chooseDownloaded(page: Page, file: { filename: string; path: string }): Promise<void> {
  await page.getByLabel('Bundle file', { exact: true }).setInputFiles({
    name: file.filename,
    mimeType: file.filename.endsWith('.json') ? 'application/json' : 'application/gzip',
    buffer: await readFile(file.path),
  });
}

/** The item with this exact title, or null — `by-title` answers 200 `{ page: null }` when there is none. */
async function pageTitled(api: APIRequestContext, title: string): Promise<unknown> {
  const res = await api.get(`/api/v1/pages/by-title/${encodeURIComponent(title)}`);
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { page: unknown }).page;
}

/** On the Export tab: pick a topic and format, Download, and return the file. */
async function exportBundle(page: Page, topic: string, format: 'json' | 'archive'): Promise<{ filename: string; path: string }> {
  await page.goto('/admin/data?tab=export');
  const exportCard = card(page, 'Export');
  await exportCard.getByLabel('Export topic').selectOption(topic);
  await exportCard.getByRole('radio', { name: format === 'json' ? /\.json envelope/ : /\.tar\.gz archive/ }).check();
  const started = page.waitForEvent('download', { timeout: 30_000 });
  await exportCard.getByRole('button', { name: 'Download' }).click();
  const download = await started;
  return { filename: download.suggestedFilename(), path: await download.path() };
}

test.describe('Admin → Data (OKF)', () => {
  test('keeps its Import · Export · Audit tabs in the URL', async ({ signedInPage: page }) => {
    await page.goto('/admin/data');
    await expect(page.getByRole('heading', { level: 1, name: 'Data' })).toBeVisible();

    const tabs = page.getByRole('tablist', { name: 'Data views' });
    await expect(tabs.getByRole('tab', { name: 'Import' })).toHaveAttribute('aria-selected', 'true');
    // Nothing chosen, so nothing to import: step 1 is the drop zone.
    await expect(card(page, 'Import')).toHaveAttribute('data-step', 'choose');
    await expect(page.getByRole('button', { name: 'Choose file…' })).toBeVisible();
    await expect(page.getByTestId('bundle-drop-zone')).toContainText(/archive recommended/i);
    await expect(importButton(page)).toHaveCount(0);

    await tabs.getByRole('tab', { name: 'Export' }).click();
    await expect(page).toHaveURL(/\/admin\/data\?tab=export$/);
    await expect(card(page, 'Export').getByRole('button', { name: 'Download' })).toBeEnabled();

    // Keyboard: arrows move between tabs and select.
    await tabs.getByRole('tab', { name: 'Export' }).press('ArrowRight');
    await expect(page).toHaveURL(/\/admin\/data\?tab=audit$/);
    await expect(tabs.getByRole('tab', { name: 'Audit' })).toBeFocused();

    await page.reload();
    await expect(page.getByRole('tab', { name: 'Audit' })).toHaveAttribute('aria-selected', 'true');
    await expect(card(page, 'Library audit')).toBeVisible();
  });

  test('exports one topic as a .json bundle with the Download button', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const space = await seedSpace(apiAsAdmin, suffix);
    const title = `Export Only ${suffix}`;
    await createPageViaApi(apiAsAdmin, {
      title,
      body: 'Exported.',
      status: 'published',
      frontmatter: { type: 'concept', topic: space.slug, description: 'Exported by the e2e.' },
    });

    const exported = await exportBundle(signedInPage, space.slug, 'json');
    expect(exported.filename).toContain(space.slug);
    expect(exported.filename).toContain(new Date().toISOString().slice(0, 10));
    expect(exported.filename).toMatch(/\.json$/);
    const bundle = JSON.parse(await readFile(exported.path, 'utf8')) as OkfBundle;
    expect(bundle.item_count).toBe(1);
    expect(bundle.conformance.conformant).toBeTruthy();
    expect(bundle.files.some((f) => f.content.includes(title))).toBeTruthy();
    await expect(card(signedInPage, 'Export').locator('.OkfAdmin__success')).toContainText(/exported 1 item\(s\)/i);
  });

  // Was quarantined `app-bug` for issue 105 (a SUCCESSFUL import rendered a TypeError).
  test('re-imports an export in place: review says it would update, the outcome says it did', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const space = await seedSpace(apiAsAdmin, suffix);
    const title = `Retry Budget ${suffix}`;
    await createPageViaApi(apiAsAdmin, {
      title,
      body: '## Overview\n\nA budget for retries.',
      status: 'published',
      frontmatter: { type: 'concept', topic: space.slug, description: 'What a retry budget is.' },
    });
    const exported = await exportBundle(signedInPage, space.slug, 'json');

    await signedInPage.getByRole('tab', { name: 'Import' }).click();
    await chooseDownloaded(signedInPage, exported);

    const importCard = card(signedInPage, 'Import');
    await expect(importCard).toHaveAttribute('data-step', 'review');
    await expect(importStatus(signedInPage)).toContainText(/ready to import|will not block the import/i, { timeout: 30_000 });
    await expect(signedInPage.locator('[data-report="validation"]')).toBeVisible();
    // What will change, before anything does: the concept matches on its embedded id.
    await expect(signedInPage.getByTestId('would-change')).toHaveText('Would update 1 existing item.');

    await importCard.getByRole('button', { name: 'Continue' }).click();
    await expect(importCard).toHaveAttribute('data-step', 'import');
    await expect(signedInPage.getByTestId('import-statement')).toContainText(/Import will update 1 existing item/);
    await expect(signedInPage.getByTestId('import-statement')).toContainText(/audit log/);

    await importButton(signedInPage).click();
    const outcome = importCard.locator('[data-outcome="import"]');
    await expect(outcome.locator('.OkfAdmin__success')).toContainText(/imported: 0 created, 1 updated/i, { timeout: 30_000 });
    await expect(outcome.getByRole('heading', { name: 'Import complete' })).toBeFocused();
    await expect(outcome.getByRole('link', { name: 'Open Content health' })).toHaveAttribute('href', '/admin/health');
    await expect(outcome.getByRole('link', { name: 'View in the audit log' })).toHaveAttribute('href', '/admin/audit?action=okf.import');
    // The bundle was consumed: a second click cannot import it again.
    await expect(importButton(signedInPage)).toHaveCount(0);

    expect(await pageTitled(apiAsAdmin, title)).not.toBeNull();
  });

  test('refuses a file that is not an OKF bundle and stays on Choose, saying what was expected', async ({ signedInPage }) => {
    await signedInPage.goto('/admin/data');
    await signedInPage.getByLabel('Bundle file', { exact: true }).setInputFiles({
      name: 'not-a-bundle.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ hello: 'world' })),
    });

    const importCard = card(signedInPage, 'Import');
    await expect(importCard.getByRole('alert')).toContainText(/unrecognized file/i);
    await expect(importCard.getByRole('alert')).toContainText(/"files" array/i);
    await expect(importCard).toHaveAttribute('data-step', 'choose');
    await expect(importCard.getByRole('button', { name: 'Continue' })).toHaveCount(0);
  });

  test('a bundle that is not conformant stays on Review with a per-file report and no way forward', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const siblingTitle = `Sibling ${suffix}`;
    const broken = untypedConcept(`Untyped ${suffix}`);
    await signedInPage.goto('/admin/data');

    await chooseJsonBundle(signedInPage, 'broken-bundle.json', [goodConcept(siblingTitle), broken]);

    const importCard = card(signedInPage, 'Import');
    // The verdict is announced in the status region, not only drawn.
    await expect(importStatus(signedInPage)).toContainText(/not a conformant okf bundle/i, { timeout: 30_000 });
    await expect(importStatus(signedInPage)).toContainText(/1 critical issue across 1 file/i);
    await expect(importCard).toHaveAttribute('data-step', 'review');
    await expect(importCard.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await expect(importCard).toContainText(/Continue is disabled: the bundle is not conformant/);
    // A refused bundle changes nothing, so there is no "would change" line.
    await expect(signedInPage.getByTestId('would-change')).toHaveCount(0);

    // File, rule and message side by side — not a one-line "Import failed".
    const conformance = signedInPage.locator('[data-report="validation"] details[data-tier="conformance"]');
    await expect(conformance).toHaveAttribute('open', '');
    const row = conformance.getByRole('row').filter({ hasText: broken.path });
    await expect(row).toContainText('type.missing');
    await expect(row).toContainText('critical');
    await expect(signedInPage.getByRole('button', { name: /copy report/i })).toBeVisible();

    // Validating wrote nothing — not even the concept that was fine.
    expect(await pageTitled(apiAsAdmin, siblingTitle)).toBeNull();
  });

  test('validates first, then imports on an explicit Import — policy findings do not block it', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const title = `Below Standard ${suffix}`;
    await signedInPage.goto('/admin/data');

    await chooseJsonBundle(signedInPage, 'flagged-bundle.json', [belowStandardConcept(title)]);

    await expect(importStatus(signedInPage)).toContainText(/will not block the import/i, { timeout: 30_000 });
    const report = signedInPage.locator('[data-report="validation"]');
    await expect(report.locator('li[data-tier="policy"]')).toContainText(/error/);
    await expect(report.locator('details[data-tier="policy"]')).toContainText('description.missing');
    await expect(signedInPage.getByTestId('would-change')).toHaveText('Would create 1 item.');

    // Choosing the file imported nothing.
    expect(await pageTitled(apiAsAdmin, title)).toBeNull();

    const importCard = card(signedInPage, 'Import');
    await importCard.getByRole('button', { name: 'Continue' }).click();
    await expect(signedInPage.getByTestId('import-statement')).toContainText(/listed in Content health/);
    await expect(importButton(signedInPage)).toBeEnabled();
    await importButton(signedInPage).click();

    const outcome = importCard.locator('[data-outcome="import"]');
    await expect(outcome.locator('.OkfAdmin__success')).toContainText(/imported: 1 created, 0 updated/i, { timeout: 30_000 });
    await expect(outcome).toContainText(/content health/i);
    await expect(outcome.getByRole('link', { name: 'Open Content health' })).toHaveAttribute('href', '/admin/health');
    // Review §2 #12: the outcome is on screen, not painted below the fold.
    await expect(outcome.getByRole('heading', { name: 'Import complete' })).toBeInViewport();

    expect(await pageTitled(apiAsAdmin, title)).not.toBeNull();
  });

  test('choosing a different bundle discards the previous review', async ({ signedInPage }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const broken = untypedConcept(`Reset Untyped ${suffix}`);
    await signedInPage.goto('/admin/data');

    await chooseJsonBundle(signedInPage, 'first.json', [broken]);
    await expect(importStatus(signedInPage)).toContainText(/not a conformant/i, { timeout: 30_000 });
    await expect(signedInPage.locator('[data-report="validation"]')).toContainText(broken.path);

    await card(signedInPage, 'Import').getByRole('button', { name: 'Choose a different bundle' }).click();
    await expect(card(signedInPage, 'Import')).toHaveAttribute('data-step', 'choose');

    await chooseJsonBundle(signedInPage, 'second.json', [goodConcept(`Reset Good ${suffix}`)]);
    await expect(importStatus(signedInPage)).toContainText(/Ready to import/i, { timeout: 30_000 });
    await expect(card(signedInPage, 'Import').getByRole('button', { name: 'Continue' })).toBeEnabled();
    const report = signedInPage.locator('[data-report="validation"]');
    await expect(report).toContainText('second.json');
    await expect(report).not.toContainText(broken.path);
  });

  // The server gates the import again — a validation is a preview, not a permit.
  // The preview is stubbed here to reach the refusal path the page must still
  // render: the 422's own per-file report, inside the Import step.
  test('a refused import renders the 422 report in the Import step', async ({ signedInPage }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const broken = untypedConcept(`Refused ${suffix}`);
    await signedInPage.route('**/api/v1/okf/validate', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          conformance: [],
          policy: [],
          advisory: [],
          summary: { conceptCount: 1, conformant: true, meetsPolicy: true, conformanceCount: 0, policyCount: 0, advisoryCount: 0, criticalCount: 0, policyErrorCount: 0 },
        }),
      }),
    );
    await signedInPage.goto('/admin/data');

    await chooseJsonBundle(signedInPage, 'refused.json', [broken]);
    const importCard = card(signedInPage, 'Import');
    await expect(importCard.getByRole('button', { name: 'Continue' })).toBeEnabled({ timeout: 30_000 });
    await importCard.getByRole('button', { name: 'Continue' }).click();
    await importButton(signedInPage).click();

    await expect(importCard.getByRole('heading', { name: 'Import refused' })).toBeFocused({ timeout: 30_000 });
    await expect(importCard.getByRole('alert')).toContainText(/nothing was imported/i);
    const refusal = signedInPage.locator('[data-report="refusal"]');
    await expect(refusal).toContainText(/1 critical issue across 1 file/i);
    await expect(refusal.getByRole('row').filter({ hasText: broken.path })).toContainText('type.missing');
    // Import is gone until a bundle is chosen again.
    await expect(importButton(signedInPage)).toHaveCount(0);
    await expect(importCard.getByRole('button', { name: 'Choose a different bundle' })).toBeVisible();
  });

  test('the .tar.gz door validates before importing too', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const space = await seedSpace(apiAsAdmin, suffix);
    await createPageViaApi(apiAsAdmin, {
      title: `Archived Concept ${suffix}`,
      body: 'Round-tripped through the archive door.',
      status: 'published',
      frontmatter: { type: 'concept', topic: space.slug, description: 'Archived and re-imported.' },
    });

    const exported = await exportBundle(signedInPage, space.slug, 'archive');
    expect(exported.filename).toMatch(/\.tar\.gz$/);

    await signedInPage.getByRole('tab', { name: 'Import' }).click();
    await chooseDownloaded(signedInPage, exported);
    await expect(importStatus(signedInPage)).toContainText(/ready to import|will not block the import/i, { timeout: 30_000 });
    await expect(signedInPage.getByTestId('would-change')).toHaveText('Would update 1 existing item.');
    await card(signedInPage, 'Import').getByRole('button', { name: 'Continue' }).click();
    await importButton(signedInPage).click();
    await expect(card(signedInPage, 'Import').locator('.OkfAdmin__success')).toContainText(/imported: 0 created, 1 updated/i, { timeout: 30_000 });
  });

  test('the Audit tab has its own topic selector and lists findings grouped by rule', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const space = await seedSpace(apiAsAdmin, suffix);
    await createPageViaApi(apiAsAdmin, {
      title: `Audited Concept ${suffix}`,
      body: 'Body of an audited concept.',
      status: 'published',
      frontmatter: { type: 'concept', topic: space.slug, description: 'Audited by the library audit.' },
    });

    await signedInPage.goto('/admin/data?tab=audit');
    const audit = card(signedInPage, 'Library audit');
    await audit.getByLabel('Audit topic').selectOption(space.slug);
    await expect(signedInPage).toHaveURL(new RegExp(`/admin/data\\?tab=audit&topic=${space.slug}$`));

    const verdict = signedInPage.getByTestId('audit-verdict');
    await expect(verdict).toContainText(/1 concept audited/i, { timeout: 30_000 });
    await expect(verdict).toContainText(/conformant/i);
    const rollup = audit.getByRole('definition').first();
    await expect(rollup).toContainText(/human-reviewed/i);
    await expect(audit).toContainText(/freshness/i);

    // All three tiers, each with a count; every advisory rule is expandable to its files.
    for (const tier of ['conformance', 'policy', 'advisories']) {
      await expect(audit.locator(`section[data-tier="${tier}"]`)).toBeVisible();
    }
    const advisories = audit.locator('section[data-tier="advisories"]');
    const firstRule = advisories.locator('details[data-rule]').first();
    if ((await firstRule.count()) > 0) {
      await firstRule.locator('summary').click();
      await expect(firstRule.getByRole('table')).toContainText('.md');
    }

    // A reload keeps the topic.
    await signedInPage.reload();
    await expect(signedInPage.getByLabel('Audit topic')).toHaveValue(space.slug);
  });

  test('the stepper fits a 360px phone, report and all', async ({ signedInPage }, testInfo) => {
    await signedInPage.setViewportSize({ width: 360, height: 800 });
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    await signedInPage.goto('/admin/data');
    await chooseJsonBundle(signedInPage, `a-very-long-bundle-file-name-without-spaces-${suffix}-${'x'.repeat(60)}.json`, [
      untypedConcept(`Phone ${suffix} ${'y'.repeat(80)}`),
    ]);
    await expect(importStatus(signedInPage)).toContainText(/not a conformant/i, { timeout: 30_000 });
    const overflow = await signedInPage.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
