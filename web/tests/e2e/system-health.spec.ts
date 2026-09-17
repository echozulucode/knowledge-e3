import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';

/**
 * Maps to features/17-system-health.feature — Admin → Health → System
 * (plan §5, issue 71; P6 polish, the admin UX review §4.9).
 *
 * The first two tests use the REAL report, so the wiring is never fully mocked
 * and the never-drilled state is exercised as it actually occurs: this e2e
 * instance has never run a restore drill, which is precisely the finding issue
 * 71 exists to make visible.
 *
 * The Healthy and Degraded verdicts cannot be produced from a browser — one
 * needs an instance with a passing drill behind it, the other a late source —
 * so they are staged at the boundary the UI consumes, the same graft
 * content-health.spec.ts uses.
 */

interface SystemCheck {
  id: string;
  title: string;
  state: 'ok' | 'warn' | 'fail';
  summary: string;
  action: string | null;
  link: { label: string; href: string } | null;
  evidence: string[];
}
interface SystemReport {
  verdict: 'healthy' | 'degraded' | 'at_risk';
  checked_at: string;
  checks: SystemCheck[];
}

/** Serve the system report with fields grafted on, leaving everything else the server said. */
async function withSystem(page: Page, mutate: (report: SystemReport) => void): Promise<void> {
  await page.route('**/api/v1/admin/health/system*', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as SystemReport;
    mutate(body);
    await route.fulfill({ status: response.status(), contentType: 'application/json', body: JSON.stringify(body) });
  });
}

const row = (page: Page, id: string) => page.locator(`li[data-check="${id}"]`);

test.describe('Admin → Health → System', () => {
  test('leads with a verdict, then the checks, each saying what to do', async ({ signedInPage }) => {
    await signedInPage.goto('/admin/health/system');

    await expect(signedInPage.getByRole('heading', { name: 'System health' })).toBeVisible({ timeout: 15_000 });

    // The answer is at the top, before any row.
    const verdict = signedInPage.getByRole('region', { name: 'Verdict' });
    await expect(verdict).toBeVisible();
    await expect(signedInPage.getByTestId('system-verdict')).toHaveText(/Healthy|Degraded|At risk/);

    // Every check this instance can answer is on the page.
    for (const id of ['database', 'schema', 'content_root', 'disk', 'sources', 'secrets', 'git_outbox', 'mirror_state', 'conflicts', 'restore_drill']) {
      await expect(row(signedInPage, id)).toBeAttached();
    }

    // The database and the schema are genuinely healthy on a running instance.
    await expect(row(signedInPage, 'database')).toContainText(/quick_check/i);
    await expect(row(signedInPage, 'schema')).toContainText(/expected tables are present/i);
  });

  test('an instance that has never run a restore drill says so, and the verdict is At risk', async ({
    signedInPage,
  }) => {
    await signedInPage.goto('/admin/health/system');
    await expect(signedInPage.getByRole('heading', { name: 'System health' })).toBeVisible({ timeout: 15_000 });

    // Never-drilled is a FINDING, not "no data": a real row, a real state, and
    // a command to run. This is the whole point of issue 71.
    const drill = row(signedInPage, 'restore_drill');
    await expect(drill).toContainText('Backups are unverified: the restore drill has never run.');
    await expect(drill).toContainText('drill:restore');
    await expect(drill).toHaveAttribute('data-tone', 'alert');

    // And it carries the verdict on its own.
    await expect(signedInPage.getByTestId('system-verdict')).toHaveText('At risk');
    await expect(signedInPage.getByRole('region', { name: 'Verdict' })).toContainText('Restore drill');
  });

  test('a command in a check is shown as code with its own Copy button, without the backticks', async ({
    signedInPage,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // The real never-drilled row carries the command; staged anyway so the
    // assertion does not depend on this instance's drill history.
    const command = 'pnpm --filter @echozedlabs/server drill:restore';
    await withSystem(signedInPage, (report) => {
      const drill = report.checks.find((c) => c.id === 'restore_drill');
      if (drill) {
        drill.state = 'fail';
        drill.summary = 'Backups are unverified: the restore drill has never run.';
        drill.action = `Run \`${command}\` once to rehearse a restore, then schedule it.`;
      }
    });
    await signedInPage.goto('/admin/health/system');

    const drill = row(signedInPage, 'restore_drill');
    await expect(drill.locator('.SystemHealth__action code')).toHaveText(command, { timeout: 15_000 });
    // The server's markup is not shown as literal backticks.
    await expect(drill.locator('.SystemHealth__action')).not.toContainText('`');

    await drill.getByRole('button', { name: `Copy ${command}` }).click();
    await expect(drill.getByRole('status')).toHaveText('Copied.');
    expect(await signedInPage.evaluate(() => navigator.clipboard.readText())).toBe(command);
  });

  test('a fully healthy instance reads Healthy, with no row asking for anything', async ({ signedInPage }) => {
    await withSystem(signedInPage, (report) => {
      report.verdict = 'healthy';
      for (const check of report.checks) {
        check.state = 'ok';
        check.action = null;
      }
      const drill = report.checks.find((c) => c.id === 'restore_drill');
      if (drill) drill.summary = 'Passed today.';
    });
    await signedInPage.goto('/admin/health/system');

    await expect(signedInPage.getByTestId('system-verdict')).toHaveText('Healthy', { timeout: 15_000 });
    await expect(signedInPage.getByRole('region', { name: 'Verdict' })).toContainText(/All \d+ checks passed\./);
    await expect(row(signedInPage, 'restore_drill')).toContainText('Passed today.');
    await expect(signedInPage.locator('li[data-check][data-tone="alert"]')).toHaveCount(0);
  });

  test('a late source reads Degraded, and the verdict names it', async ({ signedInPage }) => {
    await withSystem(signedInPage, (report) => {
      report.verdict = 'degraded';
      for (const check of report.checks) {
        check.state = 'ok';
        check.action = null;
      }
      const sources = report.checks.find((c) => c.id === 'sources');
      if (sources) {
        sources.state = 'warn';
        sources.summary = '1 of 1 enabled source(s) are behind.';
        sources.action = 'Open Sources, use Test connection on the named source, and read its last error.';
        sources.evidence = ['main: last synced 2026-08-01T00:00:00.000Z — later than 3x its 300s cadence'];
      }
    });
    await signedInPage.goto('/admin/health/system');

    await expect(signedInPage.getByTestId('system-verdict')).toHaveText('Degraded', { timeout: 15_000 });
    await expect(signedInPage.getByRole('region', { name: 'Verdict' })).toContainText(
      'Sources is working but not fully.',
    );

    const sources = row(signedInPage, 'sources');
    await expect(sources).toHaveAttribute('data-tone', 'warn');
    await expect(sources).toContainText('What to do:');
    // The evidence is available but folded away, so the row stays one line of prose.
    await expect(sources.getByRole('group')).toContainText('Evidence');
  });

  test('the failing rows sort above the passing ones', async ({ signedInPage }) => {
    await withSystem(signedInPage, (report) => {
      for (const check of report.checks) check.state = 'ok';
      const conflicts = report.checks.find((c) => c.id === 'conflicts');
      if (conflicts) conflicts.state = 'warn';
      const disk = report.checks.find((c) => c.id === 'disk');
      if (disk) disk.state = 'fail';
      report.verdict = 'at_risk';
    });
    await signedInPage.goto('/admin/health/system');
    await expect(signedInPage.getByTestId('system-verdict')).toHaveText('At risk', { timeout: 15_000 });

    const ids = await signedInPage.locator('li[data-check]').evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-check')),
    );
    expect(ids[0]).toBe('disk');
    expect(ids[1]).toBe('conflicts');
  });

  test('Health is one nav item with Content and System under it, and each page keeps its own', async ({ signedInPage }) => {
    await signedInPage.goto('/admin/health/system');
    const sub = signedInPage.getByRole('navigation', { name: 'Admin' }).getByRole('list', { name: 'Health' });
    await expect(sub).toBeVisible({ timeout: 15_000 });
    await expect(sub.getByRole('link', { name: 'System' })).toHaveAttribute('aria-current', 'page');

    await sub.getByRole('link', { name: 'Content' }).click();
    await expect(signedInPage.getByRole('heading', { name: 'Content health' })).toBeVisible();
    // /admin/health is a prefix of /admin/health/system — Content must not stay
    // lit on the System page, and System must not be lit here.
    await expect(sub.getByRole('link', { name: 'Content' })).toHaveAttribute('aria-current', 'page');
    await expect(sub.getByRole('link', { name: 'System' })).not.toHaveAttribute('aria-current', 'page');

    await sub.getByRole('link', { name: 'System' }).click();
    await expect(signedInPage.getByRole('heading', { name: 'System health' })).toBeVisible();
  });

  test('Admin overview offers Health, opening on System health', async ({ signedInPage }) => {
    await signedInPage.goto('/admin');
    // The shortcut (its nav label), not the "System health: At risk" line Needs attention may also show.
    const card = signedInPage.getByRole('region', { name: /^Operations$/i }).getByRole('link', { name: 'Health', exact: true });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toHaveAttribute('href', '/admin/health/system');
    await card.click();
    await expect(signedInPage.getByRole('heading', { name: 'System health' })).toBeVisible();
  });
});

/**
 * P6 polish (the admin UX review §4.9): passing checks folded to
 * one line, a runbook pointer per check, Copy diagnostics, freshness with
 * Refresh, a 30 s auto-refresh that pauses in a hidden tab, and a verdict live
 * region that speaks only when the verdict changes.
 */
test.describe('Admin → Health → System: density, runbook, diagnostics, refresh', () => {
  const ALL_CHECKS = ['database', 'schema', 'content_root', 'disk', 'sources', 'secrets', 'git_outbox', 'mirror_state', 'conflicts', 'restore_drill'];

  /** Every check passing except the restore drill, so both row shapes are on the page. */
  async function stageOneFailure(page: Page, extra?: (report: SystemReport) => void): Promise<void> {
    await withSystem(page, (report) => {
      report.verdict = 'at_risk';
      for (const check of report.checks) {
        check.state = 'ok';
        check.action = null;
      }
      const drill = report.checks.find((c) => c.id === 'restore_drill');
      if (drill) {
        drill.state = 'fail';
        drill.summary = 'Backups are unverified: the restore drill has never run.';
        drill.action = 'Run `pnpm --filter @echozedlabs/server drill:restore` once to rehearse a restore, then schedule it.';
      }
      extra?.(report);
    });
  }

  /** Count report requests without changing them. */
  async function countReports(page: Page): Promise<() => number> {
    let requests = 0;
    await page.route('**/api/v1/admin/health/system*', async (route) => {
      requests += 1;
      await route.fallback();
    });
    return () => requests;
  }

  test('passing checks are one folded line; the failing check is expanded, first', async ({ signedInPage: page }) => {
    await stageOneFailure(page);
    await page.goto('/admin/health/system');
    await expect(page.getByTestId('system-verdict')).toHaveText('At risk', { timeout: 15_000 });

    // Verdict first, then the failing row, then the passing ones.
    const ids = await page.locator('li[data-check]').evaluateAll((els) => els.map((el) => el.getAttribute('data-check')));
    expect(ids[0]).toBe('restore_drill');

    const drill = row(page, 'restore_drill');
    await expect(drill.getByRole('heading', { name: 'Restore drill' })).toBeVisible();
    await expect(drill).toContainText('What to do:');
    await expect(drill.locator('.SystemHealth__runbook')).toBeVisible();

    const database = row(page, 'database');
    // Name · status chip · what is true, on the one visible line.
    const line = database.locator('summary');
    await expect(line).toContainText('Database');
    await expect(line).toContainText('OK');
    await expect(line).toContainText(/quick_check/i);
    // Folded: the runbook pointer is there, but not shown until asked for.
    await expect(database.locator('details')).not.toHaveAttribute('open', '');
    await expect(database.locator('.SystemHealth__runbook')).toBeHidden();
    await line.click();
    await expect(database.locator('.SystemHealth__runbook')).toBeVisible();

    // Compact: a passing row is no taller than a couple of lines of text.
    const height = await row(page, 'schema').evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThan(64);
  });

  test('every check names its runbook section, and the address copies as it is', async ({ signedInPage: page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await stageOneFailure(page);
    await page.goto('/admin/health/system');

    const drill = row(page, 'restore_drill');
    await expect(drill.locator('.SystemHealth__runbook')).toContainText('Runbook §3.8 — Restoring from backup', { timeout: 15_000 });
    for (const id of ALL_CHECKS) {
      await expect(row(page, id).locator('.SystemHealth__runbook'), id).toHaveCount(1);
    }

    await drill.getByRole('button', { name: 'Copy runbook address for Restore drill' }).click();
    await expect(drill.getByRole('status')).toHaveText('Copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('docs/operations-runbook.md#38-restoring-from-backup');
  });

  test('Copy diagnostics puts the whole report on the clipboard as text, with no secret in it', async ({ signedInPage: page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const leaked = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
    await stageOneFailure(page, (report) => {
      // A credential riding along in free text a git error quoted — the one way
      // a secret could reach this report. The copy must not carry it.
      const sources = report.checks.find((c) => c.id === 'sources');
      if (sources) sources.evidence = [`main: last sync failed — unable to access https://bot:${leaked}@github.com/org/repo.git`];
    });
    // The OS clipboard is shared by parallel workers (another spec copies a runbook
    // address), so read what THIS page wrote rather than the clipboard itself.
    await page.addInitScript(() => {
      const write = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (value: string) => {
        (window as unknown as { __copied?: string }).__copied = value;
        return write(value);
      };
    });
    await page.goto('/admin/health/system');
    await expect(page.getByTestId('system-verdict')).toHaveText('At risk', { timeout: 15_000 });

    await page.getByRole('button', { name: 'Copy diagnostics' }).click();
    await expect(page.getByText('Diagnostics copied.')).toBeVisible();

    const text = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? '');
    expect(text.startsWith('System health diagnostics\n')).toBe(true);
    expect(text).toContain('Verdict: At risk');
    expect(text).toContain('Generated: ');
    // Worst first, like the page.
    expect(text.indexOf('(restore_drill)')).toBeLessThan(text.indexOf('(database)'));
    for (const id of ALL_CHECKS) expect(text, id).toContain(`(${id})`);
    expect(text).toContain('Backups are unverified: the restore drill has never run.');
    expect(text).not.toContain(leaked);
    expect(text).toContain('[redacted]');
  });

  test('freshness says how old the report is, and Refresh fetches a new one', async ({ signedInPage: page }) => {
    await page.clock.install();
    const requests = await countReports(page);
    await page.goto('/admin/health/system');
    await expect(page.getByTestId('system-verdict')).toBeVisible({ timeout: 15_000 });

    const freshness = page.getByRole('main').getByTestId('freshness');
    await expect(freshness).toContainText('Checked just now');
    await page.clock.fastForward(12_000);
    await expect(freshness).toContainText(/Checked 1[0-9] s ago/);

    const before = requests();
    await freshness.getByRole('button', { name: 'Refresh' }).click();
    await expect(freshness).toContainText('Checked just now');
    expect(requests()).toBeGreaterThan(before);
  });

  test('re-checks every 30 s, pauses while the tab is hidden, and catches up on return', async ({ signedInPage: page }) => {
    await page.clock.install();
    const requests = await countReports(page);
    await page.goto('/admin/health/system');
    await expect(page.getByTestId('system-verdict')).toBeVisible({ timeout: 15_000 });

    let seen = requests();
    await page.clock.runFor(31_000);
    await expect.poll(requests).toBeGreaterThan(seen);

    // A real tab switch cannot be driven from a test, so the page is told what
    // the browser would tell it: visibilityState, then visibilitychange.
    const setHidden = (hidden: boolean) =>
      page.evaluate((h) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);

    // Hidden: no request however long the tab stays in the background.
    await setHidden(true);
    seen = requests();
    await page.clock.runFor(5 * 60_000);
    expect(requests()).toBe(seen);

    // Back: the overdue report is fetched straight away.
    await setHidden(false);
    await page.clock.runFor(100);
    await expect.poll(requests).toBeGreaterThan(seen);
  });

  test('the verdict region announces a changed verdict, and only a change', async ({ signedInPage: page }) => {
    let verdict: SystemReport['verdict'] = 'at_risk';
    await withSystem(page, (report) => {
      report.verdict = verdict;
      if (verdict === 'healthy') for (const check of report.checks) check.state = 'ok';
    });
    await page.goto('/admin/health/system');
    await expect(page.getByTestId('system-verdict')).toHaveText('At risk', { timeout: 15_000 });

    const live = page.getByRole('region', { name: 'Verdict' }).locator('[aria-live="polite"]');
    await expect(live).toHaveCount(1);
    // The first load is read with the page, not announced over it.
    await expect(live).toHaveText('');

    verdict = 'healthy';
    await page.getByRole('main').getByTestId('freshness').getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByTestId('system-verdict')).toHaveText('Healthy');
    await expect(live).toHaveText('System health changed from At risk to Healthy.');
  });
});

test.describe('Admin → Health → System on a phone', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('the verdict, the rows and the header actions fit a 360px screen', async ({ signedInPage: page }) => {
    await page.goto('/admin/health/system');
    await expect(page.getByTestId('system-verdict')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Copy diagnostics' })).toBeVisible();
    await expect(row(page, 'restore_drill')).toContainText('drill:restore');

    const overflow = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>('main.SystemHealth');
      return {
        document: document.documentElement.scrollWidth - window.innerWidth,
        main: main ? main.scrollWidth - main.clientWidth : 0,
      };
    });
    expect(overflow.document).toBeLessThanOrEqual(0);
    expect(overflow.main).toBeLessThanOrEqual(1);
  });
});
