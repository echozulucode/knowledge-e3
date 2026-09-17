import { test, expect, createPageViaApi } from './fixtures.js';
import type { Page } from '@playwright/test';

/**
 * Maps to features/13-sources-and-review.feature — the Content health
 * scenarios (attention strip, findings linked to Data → Audit, fix-it queues,
 * the instance-wide Sync / Git mirror / Refusals sections) — and the review's
 * §4.9 redesign (the admin UX review).
 *
 * Two of the states this page exists to report cannot be produced from a
 * browser: a parked merge conflict needs a real remote, and a stuck mirror
 * outbox row needs a mirror that failed to confirm a commit. Both are staged at
 * the boundary the UI consumes — `GET /admin/health/content` (and, for paging,
 * `GET /admin/health/content/queues/:queue`) — exactly as external-source.spec.ts
 * stages a source onto a page read. What is under test is the operator's
 * reading of those shapes.
 *
 * The first test uses the real report, so the wiring itself is never mocked.
 *
 * Selectors the page exposes:
 *   - region "N things need attention" / "Nothing needs attention" (`[data-attention=id]` items)
 *   - region "Findings" with links `[data-finding=conformance|policy|advisories]`
 *   - region "Library counts"
 *   - list "Queues with items" (`[data-queue-choice=name]`), `[data-testid=clear-queues]`
 *   - the selected queue: `[data-queue=name]`, rows `[data-row-key=id]`, lint detail `[data-lint-for=id]`
 *   - region "Instance-wide" with `[data-testid=not-filtered]`, regions "Sync", "Git mirror", "Recent refusals"
 */

interface HealthQueue {
  count: number;
  items: unknown[];
}

interface HealthReport {
  totals: { items: number; published: number; drafts: number };
  audit: { conformant: boolean; conformance: number; policy: number; advisories: number };
  queues: Record<string, HealthQueue>;
  sync?: { conflicts: number; sources_in_conflict: string[] };
  mirror?: unknown;
}

const QUEUES = [
  'untyped',
  'uncategorized',
  'stale',
  'superseded_without_successor',
  'machine_unverified',
  'drafts_older_than_30d',
  'lint_failed_inbound',
  'declined_removal_still_deleted',
];

/** Serve the health report with fields grafted on, leaving everything else the server said. */
async function withHealth(page: Page, mutate: (report: HealthReport) => void): Promise<void> {
  // `*` stops at `/`, so this is the report and never a queue page (`content/queues/...`).
  await page.route('**/api/v1/admin/health/content*', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as HealthReport;
    mutate(body);
    await route.fulfill({ status: response.status(), contentType: 'application/json', body: JSON.stringify(body) });
  });
}

/** Every queue empty — the seeded corpus has untyped and uncategorized items, which would crowd the assertions. */
function clearAll(report: HealthReport): void {
  for (const name of QUEUES) report.queues[name] = { count: 0, items: [] };
}

function item(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { id, slug: id.replace(/^itm_/, '').replace(/_/g, '-'), title, type: 'Concept', status: 'published', updated_at: '2026-09-13T10:00:00.000Z', ...extra };
}

function queue(page: Page, name: string) {
  return page.locator(`[data-queue="${name}"]`);
}

function attention(page: Page) {
  return page.getByRole('region', { name: /needs? attention/i });
}

test.describe('Admin → Health → Content', () => {
  test('leads with attention, then findings apart from counts, with instance-wide sections labelled', async ({ signedInPage }) => {
    await signedInPage.goto('/admin/health');

    await expect(signedInPage.getByRole('heading', { level: 1, name: 'Content health' })).toBeVisible();
    await expect(attention(signedInPage)).toBeVisible({ timeout: 15_000 });

    // Freshness: when the numbers were fetched, and the way to get new ones.
    const freshness = signedInPage.getByTestId('freshness');
    await expect(freshness).toContainText(/checked/i);
    await expect(freshness.getByRole('button', { name: 'Refresh' })).toBeEnabled();

    const findings = signedInPage.getByRole('region', { name: 'Findings' });
    for (const id of ['conformance', 'policy', 'advisories']) {
      await expect(findings.locator(`[data-finding="${id}"]`)).toHaveAttribute('href', '/admin/data?tab=audit');
    }
    // Library counts are their own, quieter row — not a findings tile.
    const counts = signedInPage.getByRole('region', { name: 'Library counts' });
    await expect(counts).toContainText('Items');
    await expect(counts).toContainText('Drafts');
    await expect(findings).not.toContainText('Drafts');

    const instance = signedInPage.getByRole('region', { name: 'Instance-wide' });
    await expect(instance.getByTestId('not-filtered')).toHaveText('Not filtered by topic');
    // Nothing in this run has a remote, so nothing can be mid-merge: one line.
    await expect(instance.getByRole('region', { name: 'Sync', exact: true })).toContainText(/merging cleanly/i);
    // And the mirror is committing: the headline is the ok one, not an alert.
    await expect(signedInPage.getByTestId('mirror-headline')).toContainText(/every indexed change has reached git/i);
    await expect(instance.getByRole('region', { name: 'Git mirror', exact: true }).getByRole('button', { name: 'Copy diagnostics' })).toHaveCount(0);

    await freshness.getByRole('button', { name: 'Refresh' }).click();
    await expect(freshness).toContainText(/checked/i, { timeout: 15_000 });
  });

  test('says "Nothing needs attention" and folds clear queues into one line', async ({ signedInPage }) => {
    await withHealth(signedInPage, (report) => {
      clearAll(report);
      report.queues['untyped'] = { count: 1, items: [item('itm_only_untyped', 'Only Untyped', { type: null })] };
      report.sync = { conflicts: 0, sources_in_conflict: [] };
    });
    // Recent refusals are instance-wide audit rows, and other specs refuse publishes
    // in the same run; serve none so the strip reflects only this report.
    await signedInPage.route(/\/api\/v1\/admin\/audit\?action=content\.refused/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [], next_cursor: null, actions: [], limit: 50 }) }),
    );
    await signedInPage.goto('/admin/health');

    // Untyped is untidy, not urgent: it never makes the strip on its own.
    await expect(attention(signedInPage)).toContainText('Nothing needs attention', { timeout: 15_000 });

    const clear = signedInPage.getByTestId('clear-queues');
    await expect(clear.locator('summary')).toHaveText(/7 queues clear/);
    await expect(clear).not.toHaveAttribute('open', '');
    await expect(signedInPage.getByRole('list', { name: 'Queues with items' }).getByRole('listitem')).toHaveCount(1);

    // The one queue with something in it opens by default.
    await expect(queue(signedInPage, 'untyped').locator('[data-row-key="itm_only_untyped"]')).toContainText('Only Untyped');
  });

  test('a finding tile opens Data → Audit for the same topic', async ({ signedInPage }) => {
    await withHealth(signedInPage, (report) => {
      report.audit = { conformant: true, conformance: 0, policy: 4, advisories: 9 };
    });
    await signedInPage.goto('/admin/health?topic=default');

    const policy = signedInPage.getByRole('region', { name: 'Findings' }).locator('[data-finding="policy"]');
    await expect(policy).toContainText('4', { timeout: 15_000 });
    // Status in words as well as colour.
    await expect(policy).toContainText('Below standard');
    await expect(policy).toHaveAttribute('href', '/admin/data?tab=audit&topic=default');

    await policy.click();
    await expect(signedInPage).toHaveURL(/\/admin\/data\?tab=audit&topic=default$/);
    await expect(signedInPage.getByRole('tab', { name: 'Audit' })).toHaveAttribute('aria-selected', 'true');
    await expect(signedInPage.getByLabel('Audit topic')).toHaveValue('default');
  });

  test('the topic filter lives in the URL and leaves the instance-wide sections unfiltered', async ({ signedInPage }) => {
    await signedInPage.goto('/admin/health');
    const topicFilter = signedInPage.getByLabel('Topic filter');
    await expect(topicFilter).toBeVisible({ timeout: 15_000 });
    await topicFilter.selectOption('default');
    await expect(signedInPage).toHaveURL(/\/admin\/health\?topic=default/);
    await expect(signedInPage.getByRole('region', { name: 'Instance-wide' }).getByTestId('not-filtered')).toBeVisible({ timeout: 15_000 });
  });

  test('a draft with no type shows up in the Untyped queue and opens in Compose', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const title = `Untyped Draft ${testInfo.workerIndex}-${Date.now()}`;
    const created = await createPageViaApi(apiAsAdmin, { title, body: 'No type on this one.', status: 'draft' });

    await signedInPage.goto('/admin/health?queue=untyped');
    const untyped = queue(signedInPage, 'untyped');
    await expect(untyped).toBeVisible({ timeout: 15_000 });

    // The queue is paged, so the row is only guaranteed on page 1 when the corpus is small.
    const link = untyped.getByRole('link', { name: title });
    if ((await link.count()) > 0) {
      await expect(link).toHaveAttribute('href', new RegExp(`/p/${created.slug}/edit$`));
    } else {
      await expect(untyped.getByRole('heading', { name: 'Untyped' })).toBeVisible();
    }
  });

  test('pages a long queue through the server, 50 rows at a time', async ({ signedInPage }) => {
    const members = Array.from({ length: 120 }, (_, n) => item(`itm_stale_${n}`, `Stale Item ${String(n).padStart(3, '0')}`));
    await withHealth(signedInPage, (report) => {
      clearAll(report);
      report.queues['stale'] = { count: 120, items: members.slice(0, 50) };
    });
    const offsets: string[] = [];
    await signedInPage.route('**/api/v1/admin/health/content/queues/stale*', async (route) => {
      const url = new URL(route.request().url());
      const offset = Number(url.searchParams.get('offset'));
      offsets.push(String(offset));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ queue: 'stale', count: 120, total: 120, offset, limit: 50, items: members.slice(offset, offset + 50) }),
      });
    });
    await signedInPage.goto('/admin/health');

    const stale = queue(signedInPage, 'stale');
    await expect(stale.locator('[data-row-key="itm_stale_0"]')).toBeVisible({ timeout: 15_000 });
    const pager = stale.getByRole('navigation', { name: /pages/i });
    await expect(pager).toContainText('1–50 of 120');

    await pager.getByRole('button', { name: 'Next' }).click();
    await expect(signedInPage).toHaveURL(/queue=stale/);
    await expect(signedInPage).toHaveURL(/page=2/);
    await expect(stale.locator('[data-row-key="itm_stale_50"]')).toBeVisible();
    await expect(stale.locator('[data-row-key="itm_stale_0"]')).toHaveCount(0);
    await expect(pager).toContainText('51–100 of 120');
    expect(offsets).toContain('50');

    await pager.getByRole('button', { name: 'Next' }).click();
    await expect(pager).toContainText('101–120 of 120');
    await expect(pager.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  test('names the sources that open merge conflicts block, in the strip and in Sync', async ({ signedInPage }) => {
    await withHealth(signedInPage, (report) => {
      report.sync = { conflicts: 2, sources_in_conflict: ['topic:handbook'] };
    });
    await signedInPage.goto('/admin/health');

    const strip = attention(signedInPage);
    const item = strip.locator('[data-attention="conflicts"]');
    await expect(item).toContainText('2 open merge conflicts in topic:handbook', { timeout: 15_000 });
    await expect(item.getByRole('link')).toHaveAttribute('href', /^\/admin\/repos\?(source=[^&]+&tab=conflicts|state=attention)$/);

    const sync = signedInPage.getByRole('region', { name: 'Sync', exact: true });
    await expect(sync).toContainText(/2 open merge conflicts block/i);
    await expect(sync).toContainText('topic:handbook');
    await expect(sync.getByRole('link', { name: /sources/i })).toHaveAttribute('href', /^\/admin\/repos\?(source=[^&]+&tab=conflicts|state=attention)$/);
  });

  test('lists files that arrived with lint errors, through sync or an import, and flags them for attention', async ({ signedInPage }) => {
    await withHealth(signedInPage, (report) => {
      report.queues['lint_failed_inbound'] = { count: 1, items: [item('itm_lint_inbound', 'Arrived With Lint Errors', { slug: 'arrived-with-lint-errors' })] };
    });
    await signedInPage.goto('/admin/health');

    const strip = attention(signedInPage);
    const flagged = strip.locator('[data-attention="queue-lint_failed_inbound"]').getByRole('link');
    await expect(flagged).toContainText('Arrived with lint errors (sync or import): 1 item', { timeout: 15_000 });
    await flagged.click();
    await expect(signedInPage).toHaveURL(/queue=lint_failed_inbound/);

    const lint = queue(signedInPage, 'lint_failed_inbound');
    await expect(lint.getByRole('heading', { name: 'Arrived with lint errors (sync or import)' })).toBeVisible();
    await expect(lint.getByRole('link', { name: 'Arrived With Lint Errors' })).toHaveAttribute('href', '/p/arrived-with-lint-errors/edit');
  });

  /**
   * Review §2 #11: a declined-removal member is a DELETED row, so its editor
   * does not exist. The queue is grafted in the shape `deletedRowSummary` sends.
   */
  test('a declined removal links to its change request, not to the deleted item’s editor', async ({ signedInPage }) => {
    const url = 'https://git.example.com/org/handbook/pull/42';
    await withHealth(signedInPage, (report) => {
      report.queues['declined_removal_still_deleted'] = {
        count: 2,
        items: [
          item('itm_declined_linked', 'Retired Checklist', {
            slug: 'retired-checklist',
            review: { state: 'closed', url, branch: 'e3/remove-retired-checklist', opened_at: null, closed_at: null },
          }),
          item('itm_declined_unlinked', 'Orphaned Note', { slug: 'orphaned-note', type: null, status: 'draft', review: null }),
        ],
      };
    });
    await signedInPage.goto('/admin/health?queue=declined_removal_still_deleted');

    const declined = queue(signedInPage, 'declined_removal_still_deleted');
    await expect(declined).toBeVisible({ timeout: 15_000 });

    const linked = declined.locator('[data-row-key="itm_declined_linked"]');
    await expect(linked).toContainText('Retired Checklist');
    const changeRequest = linked.getByRole('link', { name: /open change request for retired checklist/i });
    await expect(changeRequest).toHaveAttribute('href', url);
    await expect(changeRequest).toHaveAttribute('target', '_blank');
    await expect(changeRequest).toHaveAttribute('rel', /noopener/);
    // The title is text: nothing in the queue opens the deleted item's editor.
    await expect(declined.locator('a[href$="/edit"]')).toHaveCount(0);

    // No recorded change request: the title alone, never a dead link.
    const unlinked = declined.locator('[data-row-key="itm_declined_unlinked"]');
    await expect(unlinked).toContainText('Orphaned Note');
    await expect(unlinked.getByRole('link')).toHaveCount(0);
  });

  /**
   * Plan B4: the row names the file, the source and the broken keys, in the shape
   * server/tests/content-health-lint-queue.e2e.test.ts pins for both doors.
   */
  test('each lint queue row names its file, its source, and every broken key', async ({ signedInPage }) => {
    await withHealth(signedInPage, (report) => {
      report.queues['lint_failed_inbound'] = {
        count: 2,
        items: [
          item('itm_lint_synced', 'Loose Notes', {
            slug: 'loose-notes',
            type: null,
            status: 'draft',
            lint: {
              source_id: 'topic:handbook',
              path: 'docs/loose-notes.md',
              detected_at: '2026-09-13T10:00:00.000Z',
              diagnostics: [
                { code: 'type.missing', severity: 'error', message: 'Every item needs a type.', path: 'type' },
                { code: 'category.missing', severity: 'error', message: 'Pick exactly one primary category.', path: 'categories' },
              ],
              diagnostics_total: 14,
            },
          }),
          item('itm_lint_imported', 'Below Standard', {
            slug: 'below-standard',
            type: 'Knowledge Page',
            status: 'draft',
            lint: {
              source_id: 'okf-import',
              path: 'concepts/below-standard.md',
              detected_at: '2026-09-13T10:00:00.000Z',
              diagnostics: [{ code: 'description.missing', severity: 'error', message: 'A published item needs a description.', path: 'description' }],
              diagnostics_total: 1,
            },
          }),
        ],
      };
    });
    await signedInPage.goto('/admin/health?queue=lint_failed_inbound');

    const lint = queue(signedInPage, 'lint_failed_inbound');
    await expect(lint).toBeVisible({ timeout: 15_000 });

    const syncedRow = lint.locator('[data-row-key="itm_lint_synced"]');
    // The Source column.
    await expect(syncedRow).toContainText('topic:handbook');
    const synced = lint.locator('[data-lint-for="itm_lint_synced"]');
    await expect(synced).toContainText('Sync from topic:handbook');
    await expect(synced).toContainText('docs/loose-notes.md');
    const diagnostics = synced.getByRole('list', { name: 'Lint diagnostics for Loose Notes' });
    await expect(diagnostics).toContainText('type.missing');
    await expect(diagnostics).toContainText('Every item needs a type.');
    await expect(diagnostics).toContainText('key type');
    await expect(diagnostics).toContainText('category.missing');
    await expect(diagnostics).toContainText('key categories');
    // The server capped the list; the row says how many it left off.
    await expect(diagnostics).toContainText('+12 more');
    await expect(synced).toContainText('What to do');
    await expect(synced.locator('[title*="runbook §3.5(b)"]')).toHaveCount(1);
    await expect(lint.getByRole('link', { name: 'Loose Notes' })).toHaveAttribute('href', '/p/loose-notes/edit');

    await expect(lint.locator('[data-row-key="itm_lint_imported"]')).toContainText('OKF import');
    const imported = lint.locator('[data-lint-for="itm_lint_imported"]');
    await expect(imported).toContainText('OKF import');
    await expect(imported).toContainText('concepts/below-standard.md');
    await expect(imported).toContainText('description.missing');
    await expect(imported).not.toContainText(/\+\d+ more/);
  });

  test('raises an alert when indexed changes have not reached git, and says a restart replays them', async ({ signedInPage }) => {
    await withHealth(signedInPage, (report) => {
      report.mirror = {
        stuck_after_ms: 300_000,
        pending: {
          count: 1,
          items: [
            {
              outbox_id: 'ob_1',
              page_id: 'itm_pending',
              slug: 'pending-in-git',
              title: 'Pending In Git',
              kind: 'upsert',
              source_id: 'main',
              file_path: 'concepts/pending-in-git.md',
              created_at: '2026-09-11T00:00:00.000Z',
              age_seconds: 900,
              error: null,
              mirror_state: 'missing',
              mirror_error: null,
              last_commit: null,
            },
          ],
        },
        mirror_errors: { count: 0, items: [] },
      };
    });
    await signedInPage.goto('/admin/health');

    // The strip names it and jumps to the section.
    const strip = attention(signedInPage);
    await expect(strip.locator('[data-attention="mirror"]')).toContainText('1 change not yet in git', { timeout: 15_000 });
    await expect(strip.locator('[data-attention="mirror"]').getByRole('link')).toHaveAttribute('href', '#content-health-mirror');

    const mirror = signedInPage.getByRole('region', { name: 'Git mirror', exact: true });
    await expect(signedInPage.getByTestId('mirror-headline')).toContainText(/1 change pending for more than 5 minutes/i);
    await expect(mirror).toHaveAttribute('data-tone', 'alert');
    // Durability, not data loss — the distinction the section exists to make.
    await expect(mirror).toContainText(/indexed and readable/i);
    await expect(mirror).toContainText(/restarting the server replays the pending rows/i);

    const pending = mirror.getByRole('table', { name: 'Pending mirror writes' });
    await expect(pending).toContainText('Pending In Git');
    await expect(pending).toContainText('concepts/pending-in-git.md');
    await expect(pending).toContainText('No mirror state');
    await expect(pending).toContainText('15m');
  });

  test('fits a 360px phone with long unbroken tokens in a queue', async ({ signedInPage }) => {
    await signedInPage.setViewportSize({ width: 360, height: 800 });
    const long = 'a-very-long-generated-slug-without-any-spaces-at-all-'.repeat(4);
    await withHealth(signedInPage, (report) => {
      clearAll(report);
      report.queues['lint_failed_inbound'] = {
        count: 1,
        items: [
          item('itm_long', long, {
            slug: long,
            lint: { source_id: `topic:${long}`, path: `docs/${long}.md`, detected_at: '2026-09-13T10:00:00.000Z', diagnostics: [], diagnostics_total: 0 },
          }),
        ],
      };
    });
    await signedInPage.goto('/admin/health');
    await expect(queue(signedInPage, 'lint_failed_inbound')).toBeVisible({ timeout: 15_000 });
    const overflow = await signedInPage.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

/**
 * Plan B5 / B6 — the page stops leaving the operator to find the runbook, and
 * stops making them run a SQL query to keep the evidence a restart erases.
 */
test.describe('Admin → Health → Content, pointed at the runbook', () => {
  const STUCK_MIRROR = {
    stuck_after_ms: 300_000,
    pending: {
      count: 1,
      items: [
        {
          outbox_id: 'ob_capture',
          page_id: 'itm_capture',
          slug: 'capture-the-evidence',
          title: 'Capture The Evidence',
          kind: 'upsert',
          source_id: 'main',
          file_path: 'concepts/capture-the-evidence.md',
          created_at: '2026-09-11T00:00:00.000Z',
          age_seconds: 900,
          error: null,
          mirror_state: 'missing',
          mirror_error: null,
          last_commit: null,
        },
      ],
    },
    mirror_errors: { count: 0, items: [] },
  };

  test('names the runbook section for a stuck mirror, an open conflict, and the lint queue', async ({ signedInPage }) => {
    await withHealth(signedInPage, (report) => {
      report.mirror = STUCK_MIRROR;
      report.sync = { conflicts: 1, sources_in_conflict: ['topic:handbook'] };
      report.queues['lint_failed_inbound'] = { count: 1, items: [item('itm_lint', 'Arrived With Lint Errors', { slug: 'arrived-with-lint-errors' })] };
      report.queues['untyped'] = { count: 1, items: [item('itm_untyped', 'No Type Here', { type: null })] };
    });
    await signedInPage.goto('/admin/health?queue=lint_failed_inbound');

    const mirror = signedInPage.getByRole('region', { name: 'Git mirror', exact: true });
    await expect(mirror).toContainText('runbook §3.1', { timeout: 15_000 });
    await expect(mirror).toContainText('docs/operations-runbook.md#31-content-is-indexed-but-not-reaching-git');

    const sync = signedInPage.getByRole('region', { name: 'Sync', exact: true });
    await expect(sync).toContainText('runbook §3.2');
    await expect(sync).toContainText('docs/operations-runbook.md#32-');

    const lint = queue(signedInPage, 'lint_failed_inbound');
    await expect(lint).toContainText('runbook §3.5(b)');
    await expect(lint).toContainText('docs/operations-runbook.md#b-imported-then-flagged--lint_failed_inbound');

    // A queue with no runbook section is left alone: a pointer at the
    // nearest-looking section would be a wrong answer, not a missing one.
    await signedInPage.getByRole('list', { name: 'Queues with items' }).locator('[data-queue-choice="untyped"]').getByRole('link').click();
    await expect(queue(signedInPage, 'untyped')).toBeVisible();
    await expect(queue(signedInPage, 'untyped')).not.toContainText('runbook §');
  });

  test('copies the pending rows as text a person can paste into an issue', async ({ signedInPage, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await withHealth(signedInPage, (report) => {
      report.mirror = STUCK_MIRROR;
    });
    await signedInPage.goto('/admin/health');

    const mirror = signedInPage.getByRole('region', { name: 'Git mirror', exact: true });
    await expect(mirror).toContainText('1 change pending', { timeout: 15_000 });
    await mirror.getByRole('button', { name: 'Copy diagnostics' }).click();
    await expect(mirror).toContainText(/paste them into the issue before you restart/i);

    // Every column runbook §3.1's SQL selects, off the page instead of the file.
    const copied = await signedInPage.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('ob_capture');
    expect(copied).toContain('itm_capture');
    expect(copied).toContain('upsert');
    expect(copied).toContain('main');
    expect(copied).toContain('concepts/capture-the-evidence.md');
    expect(copied).toContain('2026-09-11T00:00:00.000Z');
    expect(copied).toContain('No mirror state');
  });
});
