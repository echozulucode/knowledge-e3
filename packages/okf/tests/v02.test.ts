import { describe, it, expect } from 'vitest';
import { parse } from '@echozedlabs/codec';
import { pageToConcept } from '../src/concept.js';
import { conceptToImport } from '../src/import.js';
import {
  e3OwnerToActor,
  humanActor,
  isHumanActor,
  parseActor,
} from '../src/actor.js';
import { normalizeLifecycle, deriveLifecycle, isStale } from '../src/lifecycle.js';
import type { OkfActorEvent, PageInput } from '../src/types.js';

const noResolve = () => undefined;

function basePage(over: Partial<PageInput> = {}): PageInput {
  return {
    id: 'itm_123',
    slug: 'gut-brain-axis',
    title: 'Gut-Brain Axis',
    status: 'published',
    space: 'nutrition',
    tags: ['gut'],
    ownerId: 'usr_owner',
    rawMarkdown: '---\ntitle: Gut-Brain Axis\nsummary: How the gut talks to the brain.\n---\n\nBody.\n',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-06-01T12:00:00Z',
    ...over,
  };
}

describe('actor convention (§7)', () => {
  it('builds and classifies actors', () => {
    expect(humanActor('ericjzim')).toBe('human:ericjzim');
    expect(isHumanActor('human:ericjzim')).toBe(true);
    expect(isHumanActor('reference_agent/gemini-2.5-pro')).toBe(false);
    expect(parseActor('reference_agent/gemini-2.5-pro')).toEqual({
      kind: 'agent',
      id: 'reference_agent',
      version: 'gemini-2.5-pro',
    });
    expect(parseActor('process:git-mirror')).toEqual({ kind: 'process', id: 'git-mirror' });
  });

  it('maps a real E3 owner to human:, and the system owner to a process actor', () => {
    expect(e3OwnerToActor('usr_owner')).toBe('human:usr_owner');
    expect(e3OwnerToActor('local-system')).toBe('process:knowledge-e3');
    expect(e3OwnerToActor(null)).toBe('process:knowledge-e3');
  });
});

describe('lifecycle helpers (§5.4, §5.5)', () => {
  it('normalizes only the three v0.2 values', () => {
    expect(normalizeLifecycle('stable')).toBe('stable');
    expect(normalizeLifecycle('Deprecated')).toBe('deprecated');
    expect(normalizeLifecycle('needs_review')).toBeUndefined();
    expect(normalizeLifecycle(42)).toBeUndefined();
  });

  it('derives lifecycle from the E3 publish flag', () => {
    expect(deriveLifecycle('published')).toBe('stable');
    expect(deriveLifecycle('draft')).toBe('draft');
    expect(deriveLifecycle(undefined)).toBe('draft');
  });

  it('is a pure asOf date comparison', () => {
    expect(isStale('2026-09-23', '2026-09-22')).toBe(false);
    expect(isStale('2026-09-23', '2026-09-23')).toBe(true); // stale on/after
    expect(isStale('2026-09-23', '2026-10-01')).toBe(true);
    expect(isStale(undefined, '2030-01-01')).toBe(false);
  });
});

describe('export → v0.2 frontmatter (concept.ts)', () => {
  it('emits generated {by, at} from the E3 owner and update time', () => {
    const c = pageToConcept(basePage(), noResolve);
    expect(c.frontmatter.generated).toEqual({ by: 'human:usr_owner', at: '2026-06-01T12:00:00Z' });
  });

  it('dual-writes the legacy timestamp during the transition', () => {
    const c = pageToConcept(basePage(), noResolve);
    expect(c.frontmatter.timestamp).toBe('2026-06-01T12:00:00Z');
  });

  it('derives a v0.2 status from the publish flag when the source has none', () => {
    expect(pageToConcept(basePage({ status: 'published' }), noResolve).frontmatter.status).toBe('stable');
    expect(pageToConcept(basePage({ status: 'draft' }), noResolve).frontmatter.status).toBe('draft');
  });

  it('preserves an explicit deprecated status from the source (E3 cannot derive it)', () => {
    const page = basePage({
      status: 'published',
      rawMarkdown: '---\ntitle: T\nstatus: deprecated\n---\n\nBody.\n',
    });
    expect(pageToConcept(page, noResolve).frontmatter.status).toBe('deprecated');
  });

  it('derives status:deprecated from a governance review_status (superseded/invalidated)', () => {
    const superseded = basePage({
      status: 'published',
      rawMarkdown: '---\ntitle: T\nreview_status: superseded\n---\n\nBody.\n',
    });
    expect(pageToConcept(superseded, noResolve).frontmatter.status).toBe('deprecated');
    const invalidated = basePage({
      status: 'published',
      rawMarkdown: '---\ntitle: T\nstatus: invalidated\n---\n\nBody.\n',
    });
    const fm = pageToConcept(invalidated, noResolve).frontmatter;
    expect(fm.status).toBe('deprecated'); // governance value in `status` → deprecated
    expect(fm.review_status).toBe('invalidated'); // preserved
  });

  it('governance reviewed/needs_review does not override publish-derived status', () => {
    const page = basePage({
      status: 'published',
      rawMarkdown: '---\ntitle: T\nreview_status: needs_review\n---\n\nBody.\n',
    });
    // needs_review is not deprecated, so publish state (published → stable) wins.
    expect(pageToConcept(page, noResolve).frontmatter.status).toBe('stable');
  });

  it('moves a governance status value to review_status instead of leaking it into status', () => {
    const page = basePage({
      status: 'published',
      rawMarkdown: '---\ntitle: T\nstatus: needs_review\n---\n\nBody.\n',
    });
    const fm = pageToConcept(page, noResolve).frontmatter;
    expect(fm.status).toBe('stable'); // derived from the publish flag
    expect(fm.review_status).toBe('needs_review'); // governance value preserved
  });

  it('preserves an authored generated instead of misattributing it to E3', () => {
    const page = basePage({
      rawMarkdown:
        '---\ntitle: T\ngenerated: { by: reference_agent/gemini-2.5-pro, at: 2026-05-28T14:30:00Z }\n---\n\nBody.\n',
    });
    const fm = pageToConcept(page, noResolve).frontmatter;
    expect(fm.generated).toMatchObject({ by: 'reference_agent/gemini-2.5-pro' });
  });

  it('preserves hand-authored verified and sources through the copy path', () => {
    const page = basePage({
      rawMarkdown:
        '---\ntitle: T\nverified:\n  - { by: human:ahormati, at: 2026-06-25T09:00:00Z }\nsources:\n  - { id: pol, resource: https://x/policy, title: Policy }\n---\n\nBody.\n',
    });
    const fm = pageToConcept(page, noResolve).frontmatter;
    expect(Array.isArray(fm.verified)).toBe(true);
    expect(fm.sources).toBeTruthy();
  });
});

describe('import → v0.2 recovery (import.ts)', () => {
  it('prefers generated.at over a legacy timestamp for updatedAt', () => {
    const content =
      '---\ntype: Metric\ntitle: T\ngenerated: { by: human:ahormati, at: 2026-06-20T22:53:05Z }\ntimestamp: 2020-01-01T00:00:00Z\n---\n\nBody.\n';
    const item = conceptToImport(content);
    expect(item.updatedAt).toBe('2026-06-20T22:53:05.000Z');
    expect(item.generated?.by).toBe('human:ahormati');
  });

  it('falls back to a legacy timestamp when generated is absent (§13.1)', () => {
    const content = '---\ntype: Metric\ntitle: T\ntimestamp: 2026-05-28T14:30:00Z\n---\n\nBody.\n';
    expect(conceptToImport(content).updatedAt).toBe('2026-05-28T14:30:00.000Z');
  });

  it('normalizes a bare verified mapping to a one-element list (§5.2 MUST)', () => {
    const content =
      '---\ntype: Metric\ntitle: T\nverified: { by: human:ahormati, at: 2026-06-25T09:00:00Z }\n---\n\nBody.\n';
    const item = conceptToImport(content);
    expect(item.verified).toHaveLength(1);
    expect((item.verified as OkfActorEvent[])[0].by).toBe('human:ahormati');
  });

  it('reads sources and drops entries without a resource (§5.1)', () => {
    const content =
      '---\ntype: Metric\ntitle: T\nsources:\n  - { id: pol, resource: https://x/policy, title: Policy, usage_count: 5000, last_modified: 2026-05-30 }\n  - { id: bad, title: no-resource }\n---\n\nBody.\n';
    const item = conceptToImport(content);
    expect(item.sources).toHaveLength(1);
    expect(item.sources?.[0]).toMatchObject({
      id: 'pol',
      resource: 'https://x/policy',
      usage_count: 5000,
      last_modified: '2026-05-30',
    });
  });

  it('captures the v0.2 lifecycle while mapping deprecated to a visible E3 status', () => {
    const content = '---\ntype: Metric\ntitle: T\nstatus: deprecated\n---\n\nBody.\n';
    const item = conceptToImport(content);
    expect(item.lifecycle).toBe('deprecated');
    expect(item.status).toBe('published'); // deprecated is kept for history ⇒ still visible
  });

  it('recovers stale_after as a date string', () => {
    const content = '---\ntype: Metric\ntitle: T\nstale_after: 2026-09-23\n---\n\nBody.\n';
    expect(conceptToImport(content).staleAfter).toBe('2026-09-23');
  });

  it('does not leak consumed v0.2 keys into extraFrontmatter', () => {
    const content =
      '---\ntype: Metric\ntitle: T\ngenerated: { by: human:a, at: 2026-06-20T00:00:00Z }\nsources:\n  - { id: p, resource: https://x }\nstale_after: 2026-09-23\ncustom_key: keep-me\n---\n\nBody.\n';
    const item = conceptToImport(content);
    expect(item.extraFrontmatter).not.toHaveProperty('generated');
    expect(item.extraFrontmatter).not.toHaveProperty('sources');
    expect(item.extraFrontmatter).not.toHaveProperty('stale_after');
    expect(item.extraFrontmatter).toHaveProperty('custom_key', 'keep-me');
  });
});

describe('bundle root declares OKF v0.2', () => {
  it('stamps okf_version 0.2 in the bundle-root index', async () => {
    const { buildBundle } = await import('../src/bundle.js');
    const bundle = buildBundle([basePage()]);
    const index = bundle.files.find((f) => f.path === 'index.md');
    expect(index?.content).toContain('okf_version: "0.2"');
  });
});
