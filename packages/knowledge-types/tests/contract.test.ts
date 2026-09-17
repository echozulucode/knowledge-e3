import { describe, expect, it } from 'vitest';
import type {
  BundleValidationReport,
  ContentCommands,
  Diagnostic,
  DisplayState,
  ItemSummary,
  ItemView,
  KnowledgeQuery,
  ReviewRef,
  SearchProvider,
} from '../src/index.js';

/**
 * knowledge-types is types-only. This test exists so the package participates in
 * the workspace test gate and so a shape regression fails to compile here rather
 * than in a consumer. Assignments below are the contract; runtime assertions are
 * trivial on purpose.
 */
describe('knowledge-types contract', () => {
  it('ItemView carries the server PageView/ItemView fields', () => {
    const item: ItemView = {
      id: 'i1', slug: 's', title: 't', status: 'published', type: 'Concept', space_id: null,
      owner_id: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      published_at: null, version_token: 1, current_version_id: null, body_markdown: '', raw_markdown: '',
      frontmatter: {}, tags: [], categories: [], groups: [],
    };
    expect(item.id).toBe('i1');
  });

  it('display states and diagnostics are closed vocabularies', () => {
    const states: DisplayState[] = ['draft', 'published', 'needs-review', 'superseded', 'archived', 'in-review'];
    const d: Diagnostic = { code: 'type.missing', severity: 'error', message: 'x' };
    expect(states).toHaveLength(6);
    expect(d.severity).toBe('error');
  });

  it('a bundle validation report keeps its three tiers separate', () => {
    const report: BundleValidationReport = {
      conformance: [{ path: 'concepts/a.md', code: 'type.missing', severity: 'critical', message: 'x' }],
      policy: [{ path: 'concepts/b.md', code: 'category.missing', severity: 'error', message: 'x', field: 'categories' }],
      advisory: [{ path: 'concepts/b.md', code: 'link.unresolved', severity: 'warning', message: 'x', target: 'Ghost' }],
      summary: {
        conceptCount: 2, conformant: false, meetsPolicy: false,
        conformanceCount: 1, policyCount: 1, advisoryCount: 1,
        criticalCount: 1, policyErrorCount: 1,
      },
    };
    // `critical` is a conformance-only severity; the lint severities are the rest.
    expect(report.summary.conformant).toBe(false);
    expect(report.advisory[0]!.target).toBe('Ghost');
  });

  it('summaries carry the change request an item is staged on', () => {
    const review: ReviewRef = {
      state: 'open',
      url: 'https://github.com/acme/kb/pull/12',
      branch: 'e3/checklist-abc123',
      opened_at: '2026-01-01T00:00:00Z',
      closed_at: null,
    };
    const summary: ItemSummary = {
      id: 'i1', slug: 's', title: 't', status: 'draft', type: 'Concept', space_id: null,
      updated_at: '2026-01-01T00:00:00Z', display_state: 'in-review', review,
    };
    expect(summary.review?.state).toBe('open');
    expect(summary.display_state).toBe('in-review');
  });

  it('service interfaces are implementable', () => {
    const q: Pick<KnowledgeQuery, 'sections'> = { sections: async () => [] };
    const c: Pick<ContentCommands, 'lint'> = { lint: async () => [] };
    const p: Pick<SearchProvider, 'remove'> = { remove: async () => undefined };
    expect(typeof q.sections).toBe('function');
    expect(typeof c.lint).toBe('function');
    expect(typeof p.remove).toBe('function');
  });
});
