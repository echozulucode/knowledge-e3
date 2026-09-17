import { describe, it, expect } from 'vitest';
import type { BundleFile, OkfBundle } from '@echozedlabs/okf';
import { validateOkfBundle } from '../src/bundle-validation.js';

function concept(path: string, frontmatter: string, body = 'Body.\n'): BundleFile {
  return { path, content: `---\n${frontmatter.trim()}\n---\n\n${body}` };
}

/**
 * A concept with nothing to say about it in any tier: a registry type, one
 * category, a description, a freshness horizon, and the v0.2 trust families the
 * advisory tier looks for.
 */
const CLEAN_FRONTMATTER = `
title: Customers
type: Concept
description: Who the customers are.
categories: [Reference]
stale_after: 2099-01-01
generated:
  by: human:eric
  at: 2026-01-01T00:00:00Z
verified:
  - by: human:eric
    at: 2026-01-02T00:00:00Z
sources:
  - resource: https://example.com/crm
`;

const CUSTOMERS = concept('concepts/customers.md', CLEAN_FRONTMATTER);

const INDEX: BundleFile = {
  path: 'index.md',
  content: '---\nokf_version: "0.2"\n---\n\n# Index\n\n* [Customers](/concepts/customers.md)\n',
};
const LOG: BundleFile = { path: 'log.md', content: '# Log\n\nNothing here.\n' };

const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code);
const paths = (issues: Array<{ path: string }>) => issues.map((i) => i.path);

describe('validateOkfBundle', () => {
  it('reports nothing for a clean bundle', () => {
    const report = validateOkfBundle({ files: [CUSTOMERS] });
    expect(report.conformance).toEqual([]);
    expect(report.policy).toEqual([]);
    expect(report.advisory).toEqual([]);
    expect(report.summary).toMatchObject({
      conceptCount: 1,
      conformant: true,
      meetsPolicy: true,
      criticalCount: 0,
      policyErrorCount: 0,
    });
  });

  it('puts a missing `type` in the conformance tier as critical', () => {
    const bundle: OkfBundle = { files: [concept('concepts/bad.md', 'title: Bad')] };
    const report = validateOkfBundle(bundle);
    expect(report.conformance).toHaveLength(1);
    expect(report.conformance[0]).toMatchObject({
      path: 'concepts/bad.md',
      code: 'type.missing',
      severity: 'critical',
    });
    expect(report.summary.conformant).toBe(false);
    // The format already rejected the file; the lint adds nothing but noise.
    expect(report.policy).toEqual([]);
  });

  it('puts an unresolved wiki-link in the advisory tier, never in conformance', () => {
    const bundle: OkfBundle = {
      files: [
        CUSTOMERS,
        concept(
          'concepts/orders.md',
          'title: Orders\ntype: Concept\ndescription: Orders.\ncategories: [Reference]\nstale_after: 2099-01-01\ngenerated:\n  by: human:eric\nverified:\n  - by: human:eric\nsources:\n  - resource: https://example.com/erp',
          'Joins [[Customers]] and [[A Concept In Another Bundle]].\n',
        ),
      ],
    };
    const report = validateOkfBundle(bundle);
    expect(report.conformance).toEqual([]);
    expect(report.policy).toEqual([]);
    expect(report.advisory).toHaveLength(1);
    expect(report.advisory[0]).toMatchObject({
      path: 'concepts/orders.md',
      code: 'link.unresolved',
      severity: 'warning',
      target: 'A Concept In Another Bundle',
    });
    // Referencing a concept that lives in another bundle is legitimate OKF.
    expect(report.summary.conformant).toBe(true);
    expect(report.summary.meetsPolicy).toBe(true);
  });

  it('puts a lint failure in the policy tier only — the bundle is still valid OKF', () => {
    const bundle: OkfBundle = {
      files: [
        concept(
          'concepts/sloppy.md',
          'title: Sloppy\ntype: Concept\nstatus: published\nstale_after: 2099-01-01\ngenerated:\n  by: human:eric\nverified:\n  - by: human:eric\nsources:\n  - resource: https://example.com',
        ),
      ],
    };
    const report = validateOkfBundle(bundle);
    expect(report.conformance).toEqual([]);
    expect(codes(report.policy)).toEqual(
      expect.arrayContaining(['category.missing', 'description.missing']),
    );
    expect(report.policy.every((i) => i.path === 'concepts/sloppy.md')).toBe(true);
    expect(report.summary).toMatchObject({ conformant: true, meetsPolicy: false });
  });

  it('keeps "not an OKF bundle" and "does not meet our standards" apart', () => {
    const notOkf = validateOkfBundle({ files: [concept('concepts/a.md', 'title: A')] });
    const belowStandard = validateOkfBundle({
      files: [concept('concepts/b.md', 'title: B\ntype: Concept\nstale_after: 2099-01-01')],
    });

    // Only the first is grounds for refusing an import...
    expect(notOkf.summary.conformant).toBe(false);
    expect(belowStandard.summary.conformant).toBe(true);
    // ...and only the second is a statement about our editorial rules.
    expect(notOkf.summary.policyErrorCount).toBe(0);
    expect(belowStandard.summary.meetsPolicy).toBe(false);
    expect(belowStandard.conformance).toEqual([]);
  });

  it('exempts the reserved files from every tier', () => {
    const report = validateOkfBundle({ files: [INDEX, LOG, CUSTOMERS] });
    const all = [...report.conformance, ...report.policy, ...report.advisory];
    expect(paths(all).filter((p) => p === 'index.md' || p === 'log.md')).toEqual([]);
    expect(report.summary.conceptCount).toBe(1);
    expect(all).toEqual([]);
  });

  it('summarizes the tiers so a caller need not walk them', () => {
    const bundle: OkfBundle = {
      files: [
        concept('concepts/bad.md', 'title: Bad'), // conformance critical
        concept('concepts/thin.md', 'title: Thin\ntype: Concept\nstale_after: 2099-01-01', 'See [[Nowhere]].\n'),
      ],
    };
    const report = validateOkfBundle(bundle);
    expect(report.summary.conceptCount).toBe(2);
    expect(report.summary.conformanceCount).toBe(report.conformance.length);
    expect(report.summary.policyCount).toBe(report.policy.length);
    expect(report.summary.advisoryCount).toBe(report.advisory.length);
    expect(report.summary.criticalCount).toBe(
      report.conformance.filter((i) => i.severity === 'critical').length,
    );
    expect(report.summary.policyErrorCount).toBe(
      report.policy.filter((i) => i.severity === 'error').length,
    );
    expect(report.summary.conformant).toBe(false);
    expect(report.summary.meetsPolicy).toBe(false);
    expect(codes(report.advisory)).toContain('link.unresolved');
  });

  it('lints against the caller’s vocabularies and carries a fix through', () => {
    const bundle: OkfBundle = {
      files: [concept('concepts/x.md', 'title: X\ntype: Concept\ncategories: [Mystery]\ndescription: d.')],
    };
    const report = validateOkfBundle(bundle, { known: { categories: ['Reference'] } });
    expect(codes(report.policy)).toContain('category.unknown');
    const staleAfter = report.policy.find((i) => i.code === 'stale_after.missing');
    expect(staleAfter?.severity).toBe('info');
    expect(staleAfter?.fix?.frontmatter).toHaveProperty('stale_after');
    expect(staleAfter?.field).toBe('stale_after');
  });
});
