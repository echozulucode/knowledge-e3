import { describe, expect, it } from 'vitest';
import type { TaxonomyCategory, TaxonomyGroup, TaxonomyTag } from '../../queries.js';
import {
  arrangeTags,
  availableInLabel,
  categoryActionRules,
  effectiveSlug,
  errorText,
  filterByText,
  groupCreateBody,
  groupDraftDirty,
  groupDraftFrom,
  groupUpdateBody,
  itemsLabel,
  maxCount,
  readCategoryView,
  readTagGroupView,
  slugDiffersFromName,
  slugifyTaxonomy,
  sortByName,
  usagePercent,
  viewSearch,
} from './taxonomyAdminModel.js';

const scope = { type: 'global' as const, space_id: null, space_slug: null };
const tag = (name: string, count: number, slug = name): TaxonomyTag => ({ id: `tag_${slug}`, name, slug, count, scope });
const group = (over: Partial<TaxonomyGroup> = {}): TaxonomyGroup => ({ id: 'group_ops', name: 'Ops', slug: 'ops', count: 0, scope, ...over });

describe('slugifyTaxonomy', () => {
  it('mirrors the server: lowercase, hyphens, diacritics folded, trimmed', () => {
    expect(slugifyTaxonomy('Field Notes')).toBe('field-notes');
    expect(slugifyTaxonomy('  Café  Résumé!! ')).toBe('cafe-resume');
    expect(slugifyTaxonomy('--a__b--')).toBe('a-b');
  });

  it('returns empty for empty input instead of the server fallback', () => {
    expect(slugifyTaxonomy('')).toBe('');
    expect(slugifyTaxonomy('!!!')).toBe('');
  });

  it('caps at the DTO length', () => {
    expect(slugifyTaxonomy('a'.repeat(150))).toHaveLength(100);
  });

  it('uses the typed slug when there is one, else the name', () => {
    expect(effectiveSlug('Field Notes', '')).toBe('field-notes');
    expect(effectiveSlug('Field Notes', ' Notes 2 ')).toBe('notes-2');
  });
});

describe('URL views', () => {
  it('reads the tags/groups view, defaulting to tags', () => {
    expect(readTagGroupView({ view: 'groups' })).toBe('groups');
    expect(readTagGroupView({ view: 'nope' })).toBe('tags');
    expect(readTagGroupView(undefined)).toBe('tags');
  });

  it('reads the category view, defaulting to active', () => {
    expect(readCategoryView({ view: 'archived' })).toBe('archived');
    expect(readCategoryView({})).toBe('active');
  });

  it('drops the default view from the query string', () => {
    expect(viewSearch('tags', 'tags')).toEqual({});
    expect(viewSearch('groups', 'tags')).toEqual({ view: 'groups' });
  });
});

describe('arrangeTags', () => {
  const tags = [tag('beta', 3), tag('Alpha', 3), tag('gamma', 1), tag('delta', 9)];

  it('sorts by usage, most used first, ties by name', () => {
    expect(arrangeTags(tags, { sort: 'usage', singleUseOnly: false }).map((t) => t.name)).toEqual(['delta', 'Alpha', 'beta', 'gamma']);
  });

  it('sorts by name, case-insensitively', () => {
    expect(arrangeTags(tags, { sort: 'name', singleUseOnly: false }).map((t) => t.name)).toEqual(['Alpha', 'beta', 'delta', 'gamma']);
  });

  it('keeps only tags used by exactly one item when asked', () => {
    expect(arrangeTags(tags, { sort: 'usage', singleUseOnly: true }).map((t) => t.name)).toEqual(['gamma']);
  });

  it('does not mutate its input', () => {
    const copy = [...tags];
    arrangeTags(tags, { sort: 'name', singleUseOnly: false });
    expect(tags).toEqual(copy);
  });
});

describe('usage bar', () => {
  it('scales to the most-used entry', () => {
    expect(maxCount([{ count: 4 }, { count: 10 }, { count: 1 }])).toBe(10);
    expect(usagePercent(10, 10)).toBe(100);
    expect(usagePercent(5, 10)).toBe(50);
  });

  it('keeps a used entry visible and an unused one empty', () => {
    expect(usagePercent(1, 1000)).toBe(2);
    expect(usagePercent(0, 1000)).toBe(0);
    expect(usagePercent(3, 0)).toBe(0);
    expect(maxCount([])).toBe(0);
  });
});

describe('slugDiffersFromName', () => {
  it('hides a slug that only restates the name', () => {
    expect(slugDiffersFromName({ name: 'ai', slug: 'ai' })).toBe(false);
    expect(slugDiffersFromName({ name: 'Field Notes', slug: 'field-notes' })).toBe(false);
  });

  it('shows a slug that says something new', () => {
    expect(slugDiffersFromName({ name: 'Customer Field Notes', slug: 'field-notes' })).toBe(true);
  });
});

describe('groups', () => {
  const topics = new Map([['space_lab', 'Research Lab']]);

  it('labels where a group is available by topic name', () => {
    expect(availableInLabel(group(), topics)).toBe('All topics');
    expect(availableInLabel(group({ scope: { type: 'space', space_id: 'space_lab', space_slug: 'lab' } }), topics)).toBe('Research Lab');
    expect(availableInLabel(group({ scope: { type: 'space', space_id: 'space_gone', space_slug: 'gone' } }), topics)).toBe('gone');
  });

  it('builds a draft from a group and tracks changes', () => {
    const scoped = group({ description: 'Runs things', scope: { type: 'space', space_id: 'space_lab', space_slug: 'lab' } });
    const initial = groupDraftFrom(scoped);
    expect(initial).toEqual({ name: 'Ops', slug: '', topicId: 'space_lab', description: 'Runs things' });
    expect(groupDraftDirty(initial, initial)).toBe(false);
    expect(groupDraftDirty({ ...initial, topicId: '' }, initial)).toBe(true);
    expect(groupDraftFrom()).toEqual({ name: '', slug: '', topicId: '', description: '' });
  });

  it('states the scope in both bodies and clears a blank description on edit', () => {
    expect(groupUpdateBody({ name: ' Ops ', slug: '', topicId: '', description: '  ' })).toEqual({ name: 'Ops', description: null, scope: 'global' });
    expect(groupUpdateBody({ name: 'Ops', slug: '', topicId: 'space_lab', description: 'x' })).toEqual({ name: 'Ops', description: 'x', scope: 'space', space_id: 'space_lab' });
    expect(groupCreateBody({ name: 'Ops', slug: '', topicId: '', description: '' })).toEqual({ name: 'Ops', scope: 'global' });
    expect(groupCreateBody({ name: 'Ops', slug: 'ops-2', topicId: 'space_lab', description: 'd' })).toEqual({ name: 'Ops', slug: 'ops-2', description: 'd', scope: 'space', space_id: 'space_lab' });
  });
});

describe('categories', () => {
  const cat = (name: string, slug: string, count = 0): TaxonomyCategory => ({ name, slug, count });

  it('filters by name or slug, case-insensitively', () => {
    const list = [cat('Architecture', 'architecture'), cat('Runbooks', 'ops-runbooks')];
    expect(filterByText(list, 'OPS').map((c) => c.slug)).toEqual(['ops-runbooks']);
    expect(filterByText(list, '  ')).toHaveLength(2);
  });

  it('sorts by name', () => {
    expect(sortByName([cat('b', 'b'), cat('A', 'a')]).map((c) => c.name)).toEqual(['A', 'b']);
  });

  it('blocks archive while in use, with the count as text', () => {
    expect(categoryActionRules(cat('A', 'a', 15), true)).toEqual({ archiveReason: 'In use by 15 items' });
    expect(categoryActionRules(cat('A', 'a', 1), true)).toEqual({ archiveReason: 'In use by 1 item' });
    expect(categoryActionRules(cat('A', 'a', 0), true)).toEqual({});
  });

  it('blocks rename and archive for a term that is not in the catalog', () => {
    expect(categoryActionRules(cat('legacy', 'legacy', 0), false)).toEqual({ renameReason: 'Not in the catalog yet', archiveReason: 'Not in the catalog yet' });
  });
});

describe('words', () => {
  it('pluralizes items', () => {
    expect(itemsLabel(1)).toBe('1 item');
    expect(itemsLabel(1204)).toBe('1,204 items');
  });

  it('reads an error message or falls back', () => {
    expect(errorText(new Error('group is in use by 2 items'), 'x')).toBe('group is in use by 2 items');
    expect(errorText(null, 'Could not save.')).toBe('Could not save.');
    expect(errorText({ message: '' }, 'Could not save.')).toBe('Could not save.');
  });
});
