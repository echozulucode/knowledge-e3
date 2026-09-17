import { describe, expect, it } from 'vitest';
import { REDACTED, buildDiagnosticsText, redactSecrets } from './systemDiagnostics.js';
import { checkRunbook } from './runbook.js';
import type { SystemCheck, SystemHealthReport } from './systemVerdict.js';

const check = (over: Partial<SystemCheck> & Pick<SystemCheck, 'id' | 'state'>): SystemCheck => ({
  title: over.id,
  summary: 's',
  action: null,
  link: null,
  evidence: [],
  ...over,
});

const report: SystemHealthReport = {
  verdict: 'at_risk',
  checked_at: '2026-09-14T12:00:00.000Z',
  checks: [
    check({ id: 'database', title: 'Database', state: 'ok', summary: 'Reachable, and PRAGMA quick_check reports no corruption.', evidence: ['Journal mode: wal'] }),
    check({
      id: 'secrets',
      title: 'Secrets',
      state: 'fail',
      summary: '1 referenced env var(s) are not set.',
      action: 'Set GITHUB_TOKEN in the process environment and restart.',
      link: { label: 'Sources', href: '/admin/repos' },
      evidence: ['GITHUB_TOKEN — main host token — NOT SET', 'WEBHOOK_SECRET — main webhook secret — set'],
    }),
    check({
      id: 'restore_drill',
      title: 'Restore drill',
      state: 'fail',
      summary: 'Backups are unverified: the restore drill has never run.',
      action: 'Run `pnpm --filter @echozedlabs/server drill:restore` once, then schedule it.',
      evidence: ['No next run is scheduled.'],
    }),
    check({ id: 'conflicts', title: 'Merge conflicts', state: 'warn', summary: '2 unresolved conflict(s) across 1 source(s).' }),
  ],
};

describe('buildDiagnosticsText', () => {
  const text = buildDiagnosticsText(report, {
    copiedAt: new Date('2026-09-14T12:00:14.000Z'),
    runbookFor: checkRunbook,
    origin: 'https://kb.example.com',
  });

  it('leads with the verdict, the reason, the counts and both times', () => {
    const head = text.split('\n').slice(0, 7);
    expect(head).toEqual([
      'System health diagnostics',
      'Instance: https://kb.example.com',
      'Verdict: At risk',
      'Reason: Secrets and Restore drill need attention now.',
      'Checks: 2 at risk, 1 need attention, 1 OK',
      'Generated: 2026-09-14T12:00:00.000Z',
      'Copied: 2026-09-14T12:00:14.000Z',
    ]);
  });

  it('lists every check worst first, each with its state, id and detail', () => {
    const headings = text.split('\n').filter((line) => line.startsWith('['));
    expect(headings).toEqual([
      '[At risk] Secrets (secrets)',
      '[At risk] Restore drill (restore_drill)',
      '[Needs attention] Merge conflicts (conflicts)',
      '[OK] Database (database)',
    ]);
    expect(text).toContain('  Backups are unverified: the restore drill has never run.');
    expect(text).toContain('  What to do: Run `pnpm --filter @echozedlabs/server drill:restore` once, then schedule it.');
    expect(text).toContain('  Open: Sources (/admin/repos)');
    expect(text).toContain('    - GITHUB_TOKEN — main host token — NOT SET');
  });

  it('names the runbook section for each check', () => {
    expect(text).toContain('  Runbook: §3.8 Restoring from backup — docs/operations-runbook.md#38-restoring-from-backup');
    expect(text).toContain('  Runbook: §4 Rotate a host token — docs/operations-runbook.md#rotate-a-host-token');
  });

  it('keeps presence-only secret lines intact (names and set / NOT SET are not secrets)', () => {
    expect(text).toContain('WEBHOOK_SECRET — main webhook secret — set');
    expect(text).not.toContain(REDACTED);
  });

  it('redacts a credential that rides along in free-text evidence', () => {
    const leaky: SystemHealthReport = {
      ...report,
      checks: [
        check({
          id: 'sources',
          title: 'Sources',
          state: 'fail',
          summary: '1 of 1 enabled source(s) cannot sync.',
          evidence: [
            'main: last sync failed — fatal: unable to access https://bot:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/org/repo.git/',
            'Authorization: Bearer e3_live_abcdefghijklmnop',
          ],
        }),
      ],
    };
    const out = buildDiagnosticsText(leaky, { copiedAt: new Date(0) });
    expect(out).not.toMatch(/ghp_[A-Za-z0-9]/);
    expect(out).not.toMatch(/e3_live/);
    expect(out).not.toContain('bot:');
    expect(out).toContain(`https://${REDACTED}@github.com/org/repo.git/`);
  });
});

describe('redactSecrets', () => {
  it.each([
    ['password=hunter2', `password=${REDACTED}`],
    ['DB_PASSWORD: s3cr3t!', `DB_PASSWORD: ${REDACTED}`],
    ['api_key=abc123', `api_key=${REDACTED}`],
    ['Bearer abcdefghijkl', `Bearer ${REDACTED}`],
    ['glpat-abcdefghijklmnopqrst', REDACTED],
    ['AKIAABCDEFGHIJKLMNOP', REDACTED],
    ['xoxb-1234567890-abcdef', REDACTED],
  ])('%s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it('leaves the checks’ own prose alone', () => {
    for (const line of [
      'Missing: users, api_tokens',
      'Rotate a host token and restart the process.',
      'Measured RPO: 12s',
      'GITHUB_TOKEN — main host token — set',
      'git@github.com:org/repo.git',
    ]) {
      expect(redactSecrets(line)).toBe(line);
    }
  });
});
