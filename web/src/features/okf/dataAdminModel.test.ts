import { describe, expect, it } from 'vitest';
import type { BundleValidateResponse } from './bundleReportModel.js';
import {
  INITIAL_IMPORT_STATE,
  canContinue,
  canImport,
  classifyBundleChoice,
  dataSearchToParams,
  groupByRule,
  importOutcomeText,
  importReducer,
  importStatement,
  readDataSearch,
  stepStatus,
  tierCountText,
  wouldChangeText,
  type ImportEvent,
  type ImportState,
} from './dataAdminModel.js';

function report(over: Omit<Partial<BundleValidateResponse>, 'summary'> & { summary?: Partial<BundleValidateResponse['summary']> } = {}): BundleValidateResponse {
  const summary = {
    conceptCount: 2,
    conformant: true,
    meetsPolicy: true,
    conformanceCount: 0,
    policyCount: 0,
    advisoryCount: 0,
    criticalCount: 0,
    policyErrorCount: 0,
    ...over.summary,
  };
  return { conformance: [], policy: [], advisory: [], ...over, summary };
}

const run = (events: ImportEvent[], from: ImportState = INITIAL_IMPORT_STATE) => events.reduce(importReducer, from);

describe('readDataSearch / dataSearchToParams', () => {
  it('reads the tab and topic, defaulting to Import', () => {
    expect(readDataSearch({ tab: 'audit', topic: 'ops' })).toEqual({ tab: 'audit', topic: 'ops' });
    expect(readDataSearch({ tab: 'nope' })).toEqual({ tab: 'import', topic: '' });
    expect(readDataSearch(undefined)).toEqual({ tab: 'import', topic: '' });
  });

  it('writes only what differs, and the topic only with the Audit tab', () => {
    expect(dataSearchToParams({ tab: 'import', topic: 'ops' })).toEqual({});
    expect(dataSearchToParams({ tab: 'export', topic: 'ops' })).toEqual({ tab: 'export' });
    expect(dataSearchToParams({ tab: 'audit', topic: 'ops' })).toEqual({ tab: 'audit', topic: 'ops' });
    expect(readDataSearch(dataSearchToParams({ tab: 'audit', topic: 'handbook' }))).toEqual({ tab: 'audit', topic: 'handbook' });
  });
});

describe('classifyBundleChoice', () => {
  const f = (name: string, path = name) => ({ name, path });

  it('recognises an archive, a JSON envelope and markdown files', () => {
    expect(classifyBundleChoice([f('backup.tar.gz')])).toEqual({ kind: 'archive', index: 0 });
    expect(classifyBundleChoice([f('backup.TGZ')])).toEqual({ kind: 'archive', index: 0 });
    expect(classifyBundleChoice([f('bundle.json')])).toEqual({ kind: 'json', index: 0 });
    expect(classifyBundleChoice([f('a.md', 'repo/a.md'), f('b.md', 'repo/b.md'), f('logo.png', 'repo/logo.png')])).toEqual({
      kind: 'markdown',
      indices: [0, 1],
      label: 'repo (2 .md files)',
    });
  });

  it('ignores markdown inside .git and labels loose files', () => {
    expect(classifyBundleChoice([f('HEAD.md', 'repo/.git/HEAD.md'), f('a.md')])).toEqual({ kind: 'markdown', indices: [1], label: 'files (1 .md file)' });
  });

  it('refuses nothing, two bundles, or an unrecognised file with a sentence', () => {
    expect(classifyBundleChoice([])).toMatchObject({ kind: 'invalid' });
    expect(classifyBundleChoice([f('a.tar.gz'), f('b.json')])).toMatchObject({ kind: 'invalid', message: expect.stringMatching(/one bundle at a time/) });
    expect(classifyBundleChoice([f('a.json'), f('b.json')])).toMatchObject({ kind: 'invalid' });
    expect(classifyBundleChoice([f('notes.txt')])).toMatchObject({ kind: 'invalid', message: expect.stringMatching(/^Unrecognized file/) });
  });
});

describe('importReducer', () => {
  it('walks the happy path: choose → review → import → outcome, in one card', () => {
    let s = run([{ type: 'choose', label: 'bundle.json', selection: 1 }]);
    expect(s).toMatchObject({ step: 'review', phase: 'validating', label: 'bundle.json', selection: 1 });
    expect(canContinue(s)).toBe(false);

    s = importReducer(s, { type: 'validated', selection: 1, report: report() });
    expect(s).toMatchObject({ step: 'review', phase: 'idle' });
    expect(canContinue(s)).toBe(true);
    expect(canImport(s)).toBe(false);

    s = importReducer(s, { type: 'continue' });
    expect(s.step).toBe('import');
    expect(canImport(s)).toBe(true);

    s = importReducer(s, { type: 'importStarted' });
    expect(s.phase).toBe('importing');
    expect(canImport(s)).toBe(false);

    s = importReducer(s, { type: 'imported', outcome: { created: 1, updated: 1, assetsImported: 0, assetsFailed: 0, policyErrors: 0 } });
    expect(s).toMatchObject({ step: 'import', phase: 'idle', outcome: { created: 1 } });
    // The bundle was consumed: no second import from the same choice.
    expect(canImport(s)).toBe(false);
    expect(importReducer(s, { type: 'importStarted' })).toBe(s);
  });

  it('keeps a non-conformant bundle on Review with Continue unavailable', () => {
    const blocked = report({ summary: { conformant: false, criticalCount: 1 } });
    const s = run([{ type: 'choose', label: 'broken.json', selection: 1 }, { type: 'validated', selection: 1, report: blocked }, { type: 'continue' }]);
    expect(s.step).toBe('review');
    expect(canContinue(s)).toBe(false);
  });

  it('keeps a failed validation on Review with the error', () => {
    const s = run([{ type: 'choose', label: 'x.json', selection: 1 }, { type: 'validationFailed', selection: 1, message: 'Validation failed.' }]);
    expect(s).toMatchObject({ step: 'review', phase: 'idle', error: 'Validation failed.', report: null });
  });

  it('ignores a validation that lands after another bundle was chosen', () => {
    const s = run([
      { type: 'choose', label: 'first.json', selection: 1 },
      { type: 'choose', label: 'second.json', selection: 2 },
      { type: 'validated', selection: 1, report: report({ summary: { conformant: false } }) },
    ]);
    expect(s).toMatchObject({ label: 'second.json', phase: 'validating', report: null, selection: 2 });
  });

  it('returns to Choose with a message when the chosen file cannot be read', () => {
    const s = run([{ type: 'choose', label: 'x.json', selection: 1 }, { type: 'chooseFailed', message: 'Unrecognized file' }]);
    expect(s).toMatchObject({ step: 'choose', error: 'Unrecognized file', label: null });
  });

  it('shows a refused import on the Import step and blocks a retry until a new choice', () => {
    const refusal = report({ summary: { conformant: false, criticalCount: 1 } });
    const s = run([
      { type: 'choose', label: 'x.json', selection: 1 },
      { type: 'validated', selection: 1, report: report() },
      { type: 'continue' },
      { type: 'importStarted' },
      { type: 'importFailed', message: 'Nothing was imported.', refusal },
    ]);
    expect(s).toMatchObject({ step: 'import', refusal, error: 'Nothing was imported.', report: null });
    expect(canImport(s)).toBe(false);
    // Back from a refusal starts over rather than returning to a stale Review.
    expect(importReducer(s, { type: 'back' })).toMatchObject({ step: 'choose', refusal: null });
  });

  it('goes back one step from Import, and to Choose from Review', () => {
    const atImport = run([{ type: 'choose', label: 'x.json', selection: 1 }, { type: 'validated', selection: 1, report: report() }, { type: 'continue' }]);
    const review = importReducer(atImport, { type: 'back' });
    expect(review).toMatchObject({ step: 'review', label: 'x.json' });
    expect(importReducer(review, { type: 'back' })).toMatchObject({ step: 'choose', label: null, selection: 2 });
  });
});

describe('stepStatus', () => {
  it('marks done, current and upcoming', () => {
    expect(stepStatus('review', 'choose')).toBe('done');
    expect(stepStatus('review', 'review')).toBe('current');
    expect(stepStatus('review', 'import')).toBe('upcoming');
  });
});

describe('wouldChangeText / importStatement / importOutcomeText', () => {
  it('says what would change, or nothing when the server did not say', () => {
    expect(wouldChangeText({ would_create: 2, would_update: 1 })).toBe('Would create 2 items and update 1 existing item.');
    expect(wouldChangeText({ would_create: 0, would_update: 3 })).toBe('Would update 3 existing items.');
    expect(wouldChangeText({ would_create: 1, would_update: 0 })).toBe('Would create 1 item.');
    expect(wouldChangeText({})).toBeNull();
  });

  it('states what Import writes, including assets and policy errors', () => {
    const lines = importStatement(report({ would_create: 1, would_update: 2, assets: 3, summary: { meetsPolicy: false, policyErrorCount: 1 } }));
    expect(lines[0]).toBe('Import will create 1 item and update 2 existing items, matching concepts on their embedded id, then on title within their topic.');
    expect(lines).toContain('Up to 3 images and attachments will be restored.');
    expect(lines.some((l) => /1 policy error will not block it/.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/audit log/);
    expect(importStatement(report())[0]).toMatch(/^Import writes every concept/);
  });

  it('reports the outcome in the words the page has always used', () => {
    expect(importOutcomeText({ created: 0, updated: 1, assetsImported: 0, assetsFailed: 0, policyErrors: 0 })).toBe('Imported: 0 created, 1 updated.');
    expect(importOutcomeText({ created: 2, updated: 0, assetsImported: 3, assetsFailed: 1, policyErrors: 2 })).toBe(
      'Imported: 2 created, 0 updated · 3 asset(s) restored (1 asset(s) skipped). 2 items did not meet the content-model rules and are listed in Content health.',
    );
  });
});

describe('groupByRule / tierCountText', () => {
  it('groups every finding by rule, most severe then largest first, files in path order', () => {
    const groups = groupByRule([
      { path: 'b.md', code: 'provenance.generated.missing', severity: 'warning', message: 'x' },
      { path: 'a.md', code: 'provenance.generated.missing', severity: 'warning', message: 'x' },
      { path: 'c.md', code: 'trust.unverified', severity: 'warning', message: 'y' },
      { path: 'a.md', code: 'type.missing', severity: 'critical', message: 'z' },
      { path: 'd.md', severity: 'info', message: 'no code' },
    ]);
    expect(groups.map((g) => [g.code, g.severity, g.count])).toEqual([
      ['type.missing', 'critical', 1],
      ['provenance.generated.missing', 'warning', 2],
      ['trust.unverified', 'warning', 1],
      ['(no rule id)', 'info', 1],
    ]);
    expect(groups[1]!.issues.map((i) => i.path)).toEqual(['a.md', 'b.md']);
    expect(groups[1]!.fileCount).toBe(2);
  });

  it('keeps every issue — nothing is truncated', () => {
    const many = Array.from({ length: 250 }, (_, n) => ({ path: `c${n}.md`, code: 'r', severity: 'warning', message: 'm' }));
    expect(groupByRule(many)[0]!.issues).toHaveLength(250);
    expect(tierCountText(groupByRule(many))).toBe('250 findings across 1 rule');
    expect(tierCountText([])).toBe('No findings');
  });
});
