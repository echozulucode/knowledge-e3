import { describe, expect, it } from 'vitest';
import type { Frontmatter } from '@echozedlabs/codec';
import {
  appendVerified,
  applyTemplate,
  defaultEditorMode,
  drawerValuesFrom,
  initialFrontmatter,
  splitMarkdown,
  staleAfterFixFrom,
  tokens,
  validateForPublish,
  withDrawerValues,
  type DrawerValues,
} from './composeModel.js';

const BLOG = { key: 'blog-post', label: 'Blog Post', template: '# Title\n\nIntro.', defaultFrontmatter: { status: 'draft' } };
const CONCEPT = { key: 'concept', label: 'Concept', template: '## Definition\n', defaultFrontmatter: {} };
const TYPES = [BLOG, CONCEPT];

const EMPTY: DrawerValues = {
  topic: '',
  type: '',
  category: '',
  tags: [],
  groups: [],
  description: '',
  authors: [],
  series: '',
  seriesOrder: '',
  publishedAt: '',
  cover: '',
  status: 'draft',
  staleAfter: '',
};

describe('compose model', () => {
  it('opens blog posts in rich text and everything else in hybrid', () => {
    expect(defaultEditorMode('Blog Post', TYPES)).toBe('wysiwyg');
    expect(defaultEditorMode('blog-post', TYPES)).toBe('wysiwyg');
    expect(defaultEditorMode('Concept', TYPES)).toBe('hybrid');
    expect(defaultEditorMode(undefined, TYPES)).toBe('hybrid');
  });

  it('applies the type template only into an empty body', () => {
    expect(applyTemplate('', BLOG)).toEqual({ body: BLOG.template, applied: true });
    expect(applyTemplate('  \n', CONCEPT)).toEqual({ body: CONCEPT.template, applied: true });
    expect(applyTemplate('Authored text', BLOG)).toEqual({ body: 'Authored text', applied: false });
    expect(applyTemplate('', undefined)).toEqual({ body: '', applied: false });
  });

  it('seeds new-item frontmatter from the type defaults, label, and topic', () => {
    expect(initialFrontmatter(BLOG, 'Engineering')).toEqual({ status: 'draft', type: 'Blog Post', topic: 'Engineering' });
    expect(initialFrontmatter(undefined, '')).toEqual({ status: 'draft' });
  });

  it('carries the browse context in as seeds so creating from a filtered view keeps it', () => {
    expect(initialFrontmatter(CONCEPT, 'Engineering', { title: ' Retry budgets ', tag: 'resilience', category: 'reference', group: 'ops-review' })).toEqual({
      status: 'draft',
      type: 'Concept',
      topic: 'Engineering',
      title: 'Retry budgets',
      tags: ['resilience'],
      categories: ['reference'],
      groups: ['ops-review'],
    });
  });

  it('omits seed keys that are blank rather than writing empty values', () => {
    expect(initialFrontmatter(undefined, undefined, { title: '  ', tag: '', category: undefined })).toEqual({ status: 'draft' });
  });

  it('lets a seeded tag win over the type default so the filter that created the item survives', () => {
    const typed = { key: 'runbook', label: 'Runbook', template: '', defaultFrontmatter: { tags: ['runbook'] } };
    expect(initialFrontmatter(typed, undefined, { tag: 'incident' })).toMatchObject({ tags: ['incident'] });
  });

  it('round-trips drawer values through frontmatter using the indexed key names', () => {
    const values: DrawerValues = {
      ...EMPTY,
      topic: 'Engineering',
      type: 'Blog Post',
      category: 'How-to',
      tags: ['alpha', 'beta'],
      groups: ['onboarding'],
      description: 'A short excerpt.',
      authors: ['Ada'],
      series: 'intro-series',
      seriesOrder: '2',
      publishedAt: '2026-09-06',
      cover: '/assets/cover.png',
      status: 'published',
      staleAfter: '2027-03-06',
    };
    const fm = withDrawerValues({ title: 'Post', space: 'Old' } as Frontmatter, values);
    expect(fm).toEqual({
      title: 'Post',
      topic: 'Engineering',
      type: 'Blog Post',
      categories: ['How-to'],
      tags: ['alpha', 'beta'],
      groups: ['onboarding'],
      description: 'A short excerpt.',
      authors: ['Ada'],
      series: 'intro-series',
      series_order: 2,
      published_at: '2026-09-06',
      cover: '/assets/cover.png',
      stale_after: '2027-03-06',
      status: 'published',
    });
    expect(drawerValuesFrom(fm)).toEqual(values);
  });

  it('removes keys whose drawer value was cleared', () => {
    const fm = withDrawerValues(
      { title: 'X', categories: ['A'], tags: ['t'], description: 'd', cover: 'c', series_order: 3 } as Frontmatter,
      EMPTY,
    );
    expect(fm).toEqual({ title: 'X', status: 'draft' });
  });

  it('reads legacy space/author keys and Date values when populating the drawer', () => {
    const values = drawerValuesFrom({ space: 'Legacy', author: 'Grace', stale_after: new Date('2026-12-01T00:00:00Z') } as unknown as Frontmatter);
    expect(values.topic).toBe('Legacy');
    expect(values.authors).toEqual(['Grace']);
    expect(values.staleAfter).toBe('2026-12-01');
  });

  it('appends a human verified event without dropping earlier ones', () => {
    const fm = appendVerified({ title: 'X', verified: [{ by: 'process:lint', at: '2026-01-01T00:00:00Z' }] } as Frontmatter, 'admin', '2026-09-06T10:00:00Z');
    expect(fm.verified).toEqual([
      { by: 'process:lint', at: '2026-01-01T00:00:00Z' },
      { by: 'human:admin', at: '2026-09-06T10:00:00Z' },
    ]);
    expect(appendVerified({ title: 'X' } as Frontmatter, 'admin', 'now').verified).toEqual([{ by: 'human:admin', at: 'now' }]);
  });

  it('gates publish on title, type, one category, and description', () => {
    const errors = validateForPublish({ title: ' ', type: '', category: '', description: '', publishedAt: '', authors: [] }, TYPES);
    expect(Object.keys(errors).sort()).toEqual(['category', 'description', 'title', 'type']);
    expect(validateForPublish({ title: 'T', type: 'Concept', category: 'Reference', description: 'd', publishedAt: '', authors: [] }, TYPES)).toEqual({});
  });

  it('refuses a primary category outside the curated catalog, by slug or display name', () => {
    // Primary categories are curated, not emergent (Eric, 2026-09-11 — issues
    // 97/106). The server refuses `category.unknown` at publish; this is the
    // local mirror so the drawer says so before the request.
    const curated = ['research-notes', 'Research notes', 'how-to', 'How-to'];
    const base = { title: 'T', type: 'Concept', description: 'd', publishedAt: '', authors: [] };
    expect(validateForPublish({ ...base, category: 'research-notes' }, TYPES, curated)).toEqual({});
    // The display name is accepted too — `lintContext` feeds the lint both forms.
    expect(validateForPublish({ ...base, category: 'Research Notes' }, TYPES, curated)).toEqual({});
    expect(validateForPublish({ ...base, category: 'invented' }, TYPES, curated).category).toContain('not one of the curated');
    // An EMPTY list means "catalog not loaded yet", never "nothing is allowed":
    // only the presence of a category is checked then.
    expect(validateForPublish({ ...base, category: 'invented' }, TYPES, [])).toEqual({});
    expect(validateForPublish({ ...base, category: '' }, TYPES, curated).category).toBe('Choose exactly one primary category.');
  });

  it('requires published_at and an author for blog posts only', () => {
    const base = { title: 'T', type: 'Blog Post', category: 'How-to', description: 'd', publishedAt: '', authors: [] };
    expect(Object.keys(validateForPublish(base, TYPES)).sort()).toEqual(['authors', 'publishedAt']);
    expect(validateForPublish({ ...base, publishedAt: '2026-09-06', authors: ['Ada'] }, TYPES)).toEqual({});
    expect(validateForPublish({ ...base, type: 'Concept' }, TYPES)).toEqual({});
  });

  it('extracts the stale_after fix from write diagnostics', () => {
    expect(staleAfterFixFrom([{ code: 'stale_after.missing', fix: { frontmatter: { stale_after: '2027-01-01' } } }])).toBe('2027-01-01');
    expect(staleAfterFixFrom([{ code: 'description.missing' }])).toBeUndefined();
    expect(staleAfterFixFrom(undefined)).toBeUndefined();
  });

  it('splits a document and tokenises comma lists', () => {
    expect(splitMarkdown('---\ntitle: A\n---\nBody')).toEqual({ frontmatter: { title: 'A' }, body: 'Body' });
    expect(tokens(' a, b ,, a ')).toEqual(['a', 'b']);
  });
});
