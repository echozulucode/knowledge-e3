import { describe, expect, it } from 'vitest';
import type { BundleValidationReport } from '@echozedlabs/knowledge-types';
import {
  asBundleReport,
  criticalSummary,
  groupReport,
  importReadiness,
  refusalReport,
  reportText,
  severityLine,
  visibleRows,
} from './bundleReportModel.js';

function report(over: Partial<BundleValidationReport> = {}): BundleValidationReport {
  const base: BundleValidationReport = {
    conformance: [],
    policy: [],
    advisory: [],
    summary: {
      conceptCount: 3,
      conformant: true,
      meetsPolicy: true,
      conformanceCount: 0,
      policyCount: 0,
      advisoryCount: 0,
      criticalCount: 0,
      policyErrorCount: 0,
    },
  };
  return { ...base, ...over, summary: { ...base.summary, ...over.summary } };
}

const REFUSED = report({
  conformance: [
    { path: 'concepts/b.md', code: 'type.missing', severity: 'critical', message: 'Missing `type`.' },
    { path: 'concepts/a.md', code: 'frontmatter.warn', severity: 'warning', message: 'Odd key.' },
    { path: 'concepts/a.md', code: 'type.missing', severity: 'critical', message: 'Missing `type`.' },
    { path: 'concepts/b.md', code: 'title.missing', severity: 'critical', message: 'Missing\n`title`.' },
  ],
  advisory: [{ path: 'concepts/c.md', code: 'link.unresolved', severity: 'warning', message: 'No [[X]].', target: 'X' }],
  summary: { conformant: false, criticalCount: 3, conformanceCount: 4, advisoryCount: 1 } as BundleValidationReport['summary'],
});

describe('asBundleReport', () => {
  it('accepts the gate report and keeps summary_line and assets', () => {
    const parsed = asBundleReport({ ...REFUSED, summary_line: 'Not an OKF bundle.', assets: 2 });
    expect(parsed?.summary.conformant).toBe(false);
    expect(parsed?.conformance).toHaveLength(4);
    expect(parsed?.summary_line).toBe('Not an OKF bundle.');
    expect(parsed?.assets).toBe(2);
  });

  it('keeps what the import would change, and only as numbers', () => {
    expect(asBundleReport({ ...REFUSED, would_create: 2, would_update: 0 })).toMatchObject({ would_create: 2, would_update: 0 });
    const parsed = asBundleReport({ ...REFUSED, would_create: '2' });
    expect(parsed && 'would_create' in parsed).toBe(false);
  });

  it('rejects anything without a boolean verdict', () => {
    expect(asBundleReport(undefined)).toBeNull();
    expect(asBundleReport({ conformance: [] })).toBeNull();
    expect(asBundleReport({ summary: { conformant: 'no' } })).toBeNull();
  });

  it('drops malformed issues and derives missing counts rather than failing', () => {
    const parsed = asBundleReport({
      conformance: [{ path: 'a.md', severity: 'critical', message: 'x' }, { nope: true }, 'junk'],
      summary: { conformant: false },
    });
    expect(parsed?.conformance).toHaveLength(1);
    expect(parsed?.policy).toEqual([]);
    expect(parsed?.summary.criticalCount).toBe(1);
    expect(parsed?.summary.meetsPolicy).toBe(true);
  });
});

describe('refusalReport', () => {
  it('reads the report off an ApiError from a refused import', () => {
    const err = { statusCode: 422, reason: 'bundle_not_conformant', message: 'Nothing was imported.', validation: REFUSED };
    expect(refusalReport(err)?.summary.criticalCount).toBe(3);
  });

  it('is null for an error that carries no report', () => {
    expect(refusalReport({ statusCode: 500, message: 'boom' })).toBeNull();
    expect(refusalReport(new Error('boom'))).toBeNull();
    expect(refusalReport(null)).toBeNull();
  });
});

describe('groupReport', () => {
  it('returns all three tiers in order, most severe first, then by file', () => {
    const groups = groupReport(REFUSED);
    expect(groups.map((g) => g.tier)).toEqual(['conformance', 'policy', 'advisory']);

    const conformance = groups[0]!;
    expect(conformance.blocks).toBe(true);
    expect(conformance.rows.map((r) => `${r.severity} ${r.path} ${r.code}`)).toEqual([
      'critical concepts/a.md type.missing',
      'critical concepts/b.md type.missing',
      'critical concepts/b.md title.missing',
      'warning concepts/a.md frontmatter.warn',
    ]);
    expect(conformance.fileCount).toBe(2);
    expect(severityLine(conformance)).toBe('3 critical · 1 warning');

    expect(groups[1]!.rows).toEqual([]);
    expect(severityLine(groups[1]!)).toBe('none');
    expect(groups[2]!.rows[0]).toMatchObject({ tier: 'advisory', field: null, path: 'concepts/c.md' });
  });

  it('carries a policy issue’s field through', () => {
    const groups = groupReport(
      report({ policy: [{ path: 'p.md', code: 'description.missing', severity: 'error', message: 'Add one.', field: 'description' }] }),
    );
    expect(groups[1]!.rows[0]).toMatchObject({ field: 'description', code: 'description.missing' });
  });
});

describe('criticalSummary', () => {
  it('counts critical issues and the distinct files they are in', () => {
    expect(criticalSummary(REFUSED)).toBe('3 critical issues across 2 files');
  });

  it('uses the singular for one', () => {
    expect(criticalSummary(report({ conformance: [REFUSED.conformance[0]!] }))).toBe('1 critical issue across 1 file');
  });
});

describe('importReadiness', () => {
  it('blocks a non-conformant bundle and names what blocks it', () => {
    const r = importReadiness(REFUSED);
    expect(r).toMatchObject({ kind: 'blocked', canImport: false });
    expect(r.note).toContain('3 critical issues across 2 files');
  });

  it('allows a conformant bundle that fails policy, with a note', () => {
    const r = importReadiness(report({ summary: { meetsPolicy: false, policyErrorCount: 2, policyCount: 2 } as BundleValidationReport['summary'] }));
    expect(r).toMatchObject({ kind: 'flagged', canImport: true });
    expect(r.note).toMatch(/2 policy errors will not block the import/);
    expect(r.note).toContain('Content health');
  });

  it('allows a clean bundle and mentions non-blocking notes only when there are some', () => {
    expect(importReadiness(report()).note).toBe('Conformant (3 concept documents) and meets policy. Ready to import.');
    expect(importReadiness(report({ summary: { advisoryCount: 1 } as BundleValidationReport['summary'] })).note).toContain(
      '1 non-blocking note',
    );
  });
});

describe('visibleRows', () => {
  const rows = Array.from({ length: 120 }, (_, i) => i);

  it('shows the first 50 of a long list until asked for all', () => {
    expect(visibleRows(rows, false)).toHaveLength(50);
    expect(visibleRows(rows, true)).toHaveLength(120);
  });

  it('never truncates a short list', () => {
    expect(visibleRows(rows.slice(0, 50), false)).toHaveLength(50);
  });
});

describe('reportText', () => {
  it('is a heading, the verdict, then one line per issue — every issue, not the visible page', () => {
    const text = reportText(REFUSED, 'Validation of bundle.json');
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toBe('Validation of bundle.json');
    expect(lines[1]).toBe('Not conformant: 3 critical issues across 2 files. 3 concept documents. Conformance: 4, Policy: 0, Advisory: 1.');
    expect(lines[2]).toBe('');
    expect(lines.slice(3)).toEqual([
      'conformance | critical | concepts/a.md | - | type.missing | Missing `type`.',
      'conformance | critical | concepts/b.md | - | type.missing | Missing `type`.',
      'conformance | critical | concepts/b.md | - | title.missing | Missing `title`.',
      'conformance | warning | concepts/a.md | - | frontmatter.warn | Odd key.',
      'advisory | warning | concepts/c.md | - | link.unresolved | No [[X]].',
    ]);
  });

  it('includes the field when an issue has one', () => {
    const text = reportText(
      report({
        summary: { meetsPolicy: false, policyErrorCount: 1 } as BundleValidationReport['summary'],
        policy: [{ path: 'p.md', code: 'description.missing', severity: 'error', message: 'Add one.', field: 'description' }],
      }),
      'Report',
    );
    expect(text).toContain('Conformant; 1 policy error.');
    expect(text).toContain('policy | error | p.md | description | description.missing | Add one.');
  });
});
