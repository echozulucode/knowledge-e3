import { describe, it, expect } from 'vitest';
import { lint } from '../src/lint.js';

function doc(frontmatter: string, body = '## Overview\n\nHello.\n'): string {
  return `---\n${frontmatter.trim()}\n---\n\n${body}`;
}

const codes = (raw: string, ctx?: Parameters<typeof lint>[1]) => lint(raw, ctx).map((d) => d.code);

const GOOD = `
title: Good page
type: Concept
description: A clean page.
categories: [Reference]
stale_after: 2030-01-01
`;

describe('lint', () => {
  it('returns no diagnostics for a complete document', () => {
    expect(lint(doc(GOOD))).toEqual([]);
  });

  it('never throws on bad input', () => {
    const bad = lint(undefined as unknown as string);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.code).toBe('frontmatter.invalid');
    expect(bad[0]!.severity).toBe('error');
    expect(() => lint('')).not.toThrow();
    expect(() => lint('---\n: : :\n---\n')).not.toThrow();
  });

  describe('type', () => {
    it('type.missing (error) when absent, not when present', () => {
      expect(codes(doc('title: X\ncategories: [Reference]'))).toContain('type.missing');
      expect(codes(doc(GOOD))).not.toContain('type.missing');
    });

    it('type.unknown (warning) for a type outside the registry', () => {
      const d = lint(doc('title: X\ntype: Custom Kind\ncategories: [Reference]'));
      expect(d.find((x) => x.code === 'type.unknown')?.severity).toBe('warning');
      expect(codes(doc(GOOD))).not.toContain('type.unknown');
    });
  });

  describe('category', () => {
    it('category.missing (error) with zero categories', () => {
      expect(codes(doc('title: X\ntype: Concept'))).toContain('category.missing');
      expect(codes(doc(GOOD))).not.toContain('category.missing');
    });

    it('category.multiple (warning) with more than one', () => {
      const d = lint(doc('title: X\ntype: Concept\ne3_categories: [Reference, How-to]'));
      expect(d.find((x) => x.code === 'category.multiple')?.severity).toBe('warning');
      expect(codes(doc(GOOD))).not.toContain('category.multiple');
    });

    it('category.unknown (error) only when known categories are provided', () => {
      const raw = doc('title: X\ntype: Concept\ncategories: [Mystery]');
      expect(codes(raw)).not.toContain('category.unknown');
      expect(codes(raw, { known: { categories: ['Reference'] } })).toContain('category.unknown');
      expect(codes(raw, { known: { categories: ['mystery'] } })).not.toContain('category.unknown');
    });
  });

  describe('description', () => {
    it('description.missing (error) only when published', () => {
      const draft = doc('title: X\ntype: Concept\ncategories: [Reference]\nstatus: draft');
      expect(codes(draft)).not.toContain('description.missing');
      const published = doc('title: X\ntype: Concept\ncategories: [Reference]\ne3_status: published');
      expect(codes(published)).toContain('description.missing');
      expect(codes(draft, { published: true })).toContain('description.missing');
      expect(codes(published, { published: false })).not.toContain('description.missing');
      expect(codes(doc(GOOD + '\nstatus: published'))).not.toContain('description.missing');
    });
  });

  describe('tags', () => {
    it('tag.unknown (warning), one per unknown tag, only with a known list', () => {
      const raw = doc(GOOD + '\ntags: [alpha, beta, gamma]');
      expect(codes(raw)).not.toContain('tag.unknown');
      const d = lint(raw, { known: { tags: ['alpha'] } }).filter((x) => x.code === 'tag.unknown');
      expect(d).toHaveLength(2);
      expect(d[0]!.severity).toBe('warning');
      expect(d.map((x) => x.message)).toEqual([expect.stringContaining('"beta"'), expect.stringContaining('"gamma"')]);
    });
  });

  describe('groups', () => {
    it('group.archived (warning), once per archived group however it is spelled, only with an archived list', () => {
      const raw = doc(GOOD + '\ngroups: [Night Watch, night-watch, day-watch]');
      expect(codes(raw)).not.toContain('group.archived');
      const d = lint(raw, { known: { archivedGroups: ['night-watch'] } }).filter((x) => x.code === 'group.archived');
      expect(d).toEqual([{ code: 'group.archived', severity: 'warning', message: 'Group "Night Watch" is archived', path: 'groups' }]);
      expect(lint(raw, { known: { archivedGroups: ['night-watch'] } }).filter((x) => x.severity === 'error')).toEqual(
        lint(raw).filter((x) => x.severity === 'error'),
      );
    });
  });

  describe('stale_after', () => {
    it('stale_after.missing (info) with a per-type fix from the review horizon', () => {
      const d = lint(doc('title: X\ntype: Known Issue\ncategories: [Reference]'), { now: new Date('2026-09-06T12:00:00Z') });
      const info = d.find((x) => x.code === 'stale_after.missing');
      expect(info?.severity).toBe('info');
      expect(info?.fix?.frontmatter).toEqual({ stale_after: '2026-12-05' }); // +90 days
    });

    it('is silent when stale_after is set or the type has no review horizon', () => {
      expect(codes(doc(GOOD))).not.toContain('stale_after.missing');
      expect(codes(doc('title: X\ntype: ADR\ncategories: [Decision record]'))).not.toContain('stale_after.missing');
    });
  });

  describe('blog post', () => {
    const base = 'title: X\ntype: Blog Post\ncategories: [Blog]\ndescription: d\nstatus: published';

    it('requires published_at and an author when published', () => {
      const c = codes(doc(base));
      expect(c).toContain('blog.published_at.missing');
      expect(c).toContain('blog.author.missing');
    });

    it('passes with published_at and authors (or a single author)', () => {
      expect(codes(doc(base + '\npublished_at: 2026-09-01\nauthors: [Eric]'))).toEqual([]);
      expect(codes(doc(base + '\npublished_at: 2026-09-01\nauthor: Eric'))).toEqual([]);
    });

    it('does not apply to drafts or other types', () => {
      expect(codes(doc(base.replace('published', 'draft')))).not.toContain('blog.author.missing');
      expect(codes(doc(GOOD + '\nstatus: published'))).not.toContain('blog.published_at.missing');
    });
  });

  describe('wiki links', () => {
    const body = 'See [[Known Page]] and [[Missing Page]] and again [[Missing Page]].\n\n`[[Code Page]]`\n';

    it('link.unresolved (warning) once per unresolved target, only with resolvable slugs', () => {
      expect(codes(doc(GOOD, body))).not.toContain('link.unresolved');
      const d = lint(doc(GOOD, body), { resolvableSlugs: new Set(['known-page']) }).filter((x) => x.code === 'link.unresolved');
      expect(d).toHaveLength(1);
      expect(d[0]!.severity).toBe('warning');
      expect(d[0]!.message).toContain('[[Missing Page]]');
    });

    it('accepts targets given as titles or slugs', () => {
      const ctx = { resolvableSlugs: new Set(['Known Page', 'missing-page']) };
      expect(codes(doc(GOOD, body), ctx)).not.toContain('link.unresolved');
    });
  });
});
