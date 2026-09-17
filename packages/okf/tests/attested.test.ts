import { describe, it, expect } from 'vitest';
import {
  isAttestedComputation,
  hasComputationSection,
  readAttestedContract,
  validateAttestedComputation,
  classifyPathValue,
} from '../src/attested.js';
import { validateBundle } from '../src/conformance.js';
import { parse } from '@echozedlabs/codec';

// The spec §10.2 worked example, inline computation form.
const REVENUE = `---
type: Attested Computation
title: Revenue for fiscal year
status: stable
runtime: bigquery
parameters:
  - { name: year, type: integer, required: true }
executor:
  resource: references/skills/run-on-bq.md
  receipt: [job_id, executed_sql, result]
attester:
  resource: references/attesters/revenue.py
generated: { by: reference_agent/gemini-2.5-pro, at: 2026-06-20T22:53:05Z }
---

# Computation

    SELECT SUM(amount) AS revenue
    FROM finance.recognized_revenue
    WHERE fiscal_year = @year
`;

describe('Attested Computation contract (§10)', () => {
  it('detects the type and the inline computation section', () => {
    const { frontmatter, body } = parse(REVENUE);
    expect(isAttestedComputation(frontmatter as Record<string, unknown>)).toBe(true);
    expect(isAttestedComputation({ type: 'Metric' })).toBe(false);
    expect(hasComputationSection(body)).toBe(true);
    expect(hasComputationSection('# Definition\n\nno computation here')).toBe(false);
  });

  it('reads the full contract', () => {
    const fm = parse(REVENUE).frontmatter as Record<string, unknown>;
    const c = readAttestedContract(fm);
    expect(c.runtime).toBe('bigquery');
    expect(c.parameters).toEqual([{ name: 'year', type: 'integer', required: true }]);
    expect(c.executor?.receipt).toEqual(['job_id', 'executed_sql', 'result']);
    expect(c.attester?.resource).toBe('references/attesters/revenue.py');
  });

  it('classifies path-valued fields (§6.2)', () => {
    expect(classifyPathValue('https://x/y')).toBe('absolute-url');
    expect(classifyPathValue('/tables/orders.md')).toBe('bundle-relative');
    expect(classifyPathValue('../computations/revenue.md')).toBe('relative');
    expect(classifyPathValue('')).toBeUndefined();
  });

  it('passes a well-formed inline computation and reports readiness', () => {
    const fm = parse(REVENUE).frontmatter as Record<string, unknown>;
    const { issues, readiness } = validateAttestedComputation(fm, 'computations/revenue.md', true);
    expect(issues.filter((i) => i.severity === 'critical')).toHaveLength(0);
    expect(readiness.structuralReady).toBe(true);
    expect(readiness.attestationReady).toBe(true);
  });

  it('flags a missing runtime as critical', () => {
    const fm = { type: 'Attested Computation', title: 'x' } as Record<string, unknown>;
    const { issues, readiness } = validateAttestedComputation(fm, 'c.md', true);
    expect(issues.some((i) => i.severity === 'critical' && /runtime/.test(i.message))).toBe(true);
    expect(readiness.structuralReady).toBe(false);
  });

  it('warns when no computation is provided at all', () => {
    const fm = { type: 'Attested Computation', runtime: 'python' } as Record<string, unknown>;
    const { issues } = validateAttestedComputation(fm, 'c.md', false);
    expect(issues.some((i) => /No computation found/.test(i.message))).toBe(true);
  });

  it('warns when both inline and file computations are present', () => {
    const fm = { type: 'Attested Computation', runtime: 'python', computation: 'refs/x.py' } as Record<
      string,
      unknown
    >;
    const { issues } = validateAttestedComputation(fm, 'c.md', true);
    expect(issues.some((i) => /Both an inline/.test(i.message))).toBe(true);
  });

  it('warns on duplicate parameter names (names only, never values)', () => {
    const fm = {
      type: 'Attested Computation',
      runtime: 'python',
      parameters: [{ name: 'year' }, { name: 'year' }],
    } as Record<string, unknown>;
    const { issues } = validateAttestedComputation(fm, 'c.md', true);
    expect(issues.some((i) => /Duplicate parameter name/.test(i.message))).toBe(true);
  });

  it('warns on a malformed path-valued field', () => {
    const fm = {
      type: 'Attested Computation',
      runtime: 'python',
      attester: { resource: 'not a path with spaces' },
    } as Record<string, unknown>;
    const { issues } = validateAttestedComputation(fm, 'c.md', true);
    expect(issues.some((i) => /attester\.resource/.test(i.message))).toBe(true);
  });
});

describe('validateBundle integrates Attested Computation checks', () => {
  it('accepts a well-formed attested computation concept', () => {
    const report = validateBundle({ files: [{ path: 'computations/revenue.md', content: REVENUE }] });
    expect(report.conformant).toBe(true);
  });

  it('rejects an attested computation with no runtime (critical)', () => {
    const bad = '---\ntype: Attested Computation\ntitle: x\n---\n\n# Computation\n\n    SELECT 1\n';
    const report = validateBundle({ files: [{ path: 'computations/bad.md', content: bad }] });
    expect(report.conformant).toBe(false);
    expect(report.issues.some((i) => /runtime/.test(i.message))).toBe(true);
  });
});
