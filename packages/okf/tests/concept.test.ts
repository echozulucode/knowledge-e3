import { describe, it, expect } from 'vitest';
import { parse } from '@echozedlabs/codec';
import { pageToConcept, conceptPathForSlug } from '../src/concept.js';
import type { PageInput } from '../src/types.js';

const noResolve = () => undefined;

function basePage(over: Partial<PageInput> = {}): PageInput {
  return {
    id: 'itm_123',
    slug: 'gut-brain-axis',
    title: 'Gut-Brain Axis',
    status: 'published',
    space: 'nutrition',
    tags: ['gut', 'brain'],
    categories: ['concept'],
    groups: ['neuro'],
    ownerId: 'usr_owner',
    rawMarkdown: '---\ntitle: Gut-Brain Axis\nsummary: How the gut talks to the brain.\n---\n\n# Gut-Brain Axis\n\nBody.\n',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-06-01T12:00:00Z',
    ...over,
  };
}

describe('pageToConcept', () => {
  it('produces a non-empty required type', () => {
    const c = pageToConcept(basePage(), noResolve);
    expect(typeof c.frontmatter.type).toBe('string');
    expect(c.frontmatter.type).not.toBe('');
  });

  it('honors an explicit frontmatter type over the default', () => {
    const page = basePage({
      rawMarkdown: '---\ntitle: T\ntype: Playbook\n---\n\nBody.\n',
    });
    const c = pageToConcept(page, noResolve);
    expect(c.frontmatter.type).toBe('Playbook');
  });

  it('falls back to the default type when none is declared', () => {
    const c = pageToConcept(basePage(), noResolve, { defaultType: 'Note' });
    expect(c.frontmatter.type).toBe('Note');
  });

  it('embeds the immutable E3 id and identity for lossless re-import', () => {
    const c = pageToConcept(basePage(), noResolve);
    expect(c.frontmatter.e3_id).toBe('itm_123');
    expect(c.frontmatter.e3_slug).toBe('gut-brain-axis');
    expect(c.frontmatter.e3_status).toBe('published');
    expect(c.frontmatter.e3_space).toBe('nutrition');
    expect(c.frontmatter.e3_categories).toEqual(['concept']);
    expect(c.frontmatter.e3_groups).toEqual(['neuro']);
    expect(c.frontmatter.e3_owner_id).toBe('usr_owner');
    expect(c.frontmatter.e3_created_at).toBe('2026-01-01T00:00:00Z');
  });

  it('maps summary to OKF description and updatedAt to timestamp', () => {
    const c = pageToConcept(basePage(), noResolve);
    expect(c.frontmatter.description).toBe('How the gut talks to the brain.');
    expect(c.frontmatter.timestamp).toBe('2026-06-01T12:00:00Z');
  });

  it('merges page tags with frontmatter tags, de-duplicated', () => {
    const page = basePage({
      tags: ['gut', 'brain'],
      rawMarkdown: '---\ntitle: T\ntags: [brain, microbiome]\n---\n\nBody.\n',
    });
    const c = pageToConcept(page, noResolve);
    expect(c.frontmatter.tags).toEqual(['gut', 'brain', 'microbiome']);
  });

  it('preserves unknown producer-defined frontmatter keys', () => {
    const page = basePage({
      rawMarkdown: '---\ntitle: T\ncustom_field: keep-me\n---\n\nBody.\n',
    });
    const c = pageToConcept(page, noResolve);
    expect(c.frontmatter.custom_field).toBe('keep-me');
  });

  it('emits a path derived from the slug and a parseable document', () => {
    const c = pageToConcept(basePage(), noResolve);
    expect(c.path).toBe('concepts/gut-brain-axis.md');
    expect(conceptPathForSlug('gut-brain-axis')).toBe('concepts/gut-brain-axis.md');
    // The rendered concept round-trips through the codec parser.
    const reparsed = parse(c.content);
    expect(reparsed.frontmatter.type).toBe(c.frontmatter.type);
    expect(reparsed.frontmatter.e3_id).toBe('itm_123');
    expect(reparsed.body).toContain('Body.');
  });

  it('derives a title from the slug when none is available', () => {
    const page = basePage({ title: '', rawMarkdown: '\nBody only, no frontmatter.\n' });
    const c = pageToConcept(page, noResolve);
    // A slug fallback can't recover original punctuation; hyphens become spaces.
    expect(c.frontmatter.title).toBe('Gut Brain Axis');
  });
});
