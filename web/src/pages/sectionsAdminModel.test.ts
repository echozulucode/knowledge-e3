import { describe, expect, it } from 'vitest';
import {
  FRONT_PAGE_KEY,
  appearsOn,
  applyGroupOrder,
  createLimiter,
  deleteConsequences,
  draftFromSection,
  duplicateDraft,
  filterSections,
  findContentTypeLabel,
  groupSections,
  hasProblems,
  leadSlug,
  matchFilters,
  moveInGroup,
  moveSlug,
  nextOrderInGroup,
  ordinal,
  positionLabel,
  removeSection,
  restoreOrders,
  restoreSection,
  sameSection,
  sectionFromDraft,
  slotApplies,
  slotOptionLabel,
  slugifySection,
  uniqueSlug,
  upsertSection,
  validateSection,
  type SectionDef,
  type TopicRef,
} from './sectionsAdminModel.js';

const topics: TopicRef[] = [
  { id: 't-ops', slug: 'operations', name: 'Operations', presentation: 'portal' },
  { id: 't-def', slug: 'default', name: 'Default', presentation: 'wiki' },
  { id: 't-arch', slug: 'architecture', name: 'Architecture', presentation: 'docs', visibility: 'private' },
];

const sections: SectionDef[] = [
  { slug: 'best-practices', name: 'Best practices', type: 'Best Practice', order: 20, limit: 10 },
  { slug: 'updates', name: 'Updates', tags: ['update'], order: 10, limit: 12 },
  { slug: 'runbooks', name: 'Runbooks', type: 'Runbook', space: 'operations', slot: 'essential', order: 10 },
  { slug: 'adr', name: 'ADRs', space: 't-arch', order: 10 },
  { slug: 'unordered', name: 'Aardvark' },
];

describe('slugs', () => {
  it('mirrors the server’s slugifySection', () => {
    expect(slugifySection('  Release Notes! ')).toBe('release-notes');
    expect(slugifySection('--a__b--')).toBe('a-b');
    expect(slugifySection('Café')).toBe('caf');
    expect(slugifySection('!!!')).toBe('');
  });

  it('finds a free slug', () => {
    expect(uniqueSlug('Updates', ['news'])).toBe('updates');
    expect(uniqueSlug('Updates', ['updates', 'updates-2'])).toBe('updates-3');
    expect(uniqueSlug('!!!', [])).toBe('section');
  });
});

describe('grouping and the lead', () => {
  it('groups front page first, then topics by name, resolving a topic id to its slug', () => {
    const groups = groupSections(sections, topics, 'default');
    expect(groups.map((g) => g.key)).toEqual([FRONT_PAGE_KEY, 'architecture', 'operations']);
    expect(groups[0]!.sections.map((s) => s.slug)).toEqual(['updates', 'best-practices', 'unordered']);
    expect(groups[1]!.label).toBe('Topic: Architecture (docs, private)');
    expect(groups[2]!.label).toBe('Topic: Operations (portal)');
  });

  it('labels a section whose topic no longer exists', () => {
    const groups = groupSections([{ slug: 'x', name: 'X', space: 'gone' }], topics);
    expect(groups[0]!.label).toBe('Topic: gone (not found)');
  });

  it('leads with the lowest-ordered front-page section that matches something', () => {
    expect(leadSlug(sections)).toBe('updates');
    expect(leadSlug(sections, { updates: 0 })).toBe('best-practices');
    // Unknown counts (still loading) do not move the lead.
    expect(leadSlug(sections, { updates: undefined })).toBe('updates');
    expect(leadSlug(sections.filter((s) => s.space))).toBeUndefined();
  });

  it('knows where Slot matters: front page, the home topic, portal topics', () => {
    expect(slotApplies(undefined, topics, 'default')).toBe(true);
    expect(slotApplies('operations', topics, 'default')).toBe(true);
    expect(slotApplies('t-ops', topics, 'default')).toBe(true);
    expect(slotApplies('default', topics, 'default')).toBe(true);
    expect(slotApplies('architecture', topics, 'default')).toBe(false);
    expect(slotApplies('gone', topics, 'default')).toBe(false);
  });

  it('filters by search text and placement', () => {
    expect(filterSections(sections, topics, { query: 'runbook' }).map((s) => s.slug)).toEqual(['runbooks']);
    expect(filterSections(sections, topics, { query: 'update' }).map((s) => s.slug)).toEqual(['updates']);
    expect(filterSections(sections, topics, { query: 'operations' }).map((s) => s.slug)).toEqual(['runbooks']);
    expect(filterSections(sections, topics, { placement: FRONT_PAGE_KEY })).toHaveLength(3);
    expect(filterSections(sections, topics, { placement: 'architecture' }).map((s) => s.slug)).toEqual(['adr']);
    expect(filterSections(sections, topics, { placement: 'all', query: '' })).toHaveLength(5);
  });
});

describe('position and order', () => {
  it('describes the position within the placement group', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(22)).toBe('22nd');
    expect(positionLabel('best-practices', sections, topics)?.label).toBe('2nd of 3 on Front page');
    expect(positionLabel('runbooks', sections, topics)?.label).toBe('1st of 1 on Operations');
    expect(positionLabel('nope', sections, topics)).toBeUndefined();
  });

  it('writes 10, 20, 30 within a group and leaves other groups alone', () => {
    const next = applyGroupOrder(sections, ['unordered', 'updates', 'best-practices']);
    expect(next.find((s) => s.slug === 'unordered')?.order).toBe(10);
    expect(next.find((s) => s.slug === 'updates')?.order).toBe(20);
    expect(next.find((s) => s.slug === 'best-practices')?.order).toBe(30);
    expect(next.find((s) => s.slug === 'runbooks')?.order).toBe(10);
  });

  it('moves up and down within the group, ignoring moves off the ends', () => {
    expect(moveSlug(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveSlug(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    const moved = moveInGroup(sections, 'best-practices', -1, topics);
    expect(leadSlug(moved)).toBe('best-practices');
    expect(moved.find((s) => s.slug === 'updates')?.order).toBe(20);
  });

  it('undoes a reorder with the exact previous orders, unordered included', () => {
    const slugs = ['updates', 'best-practices', 'unordered'];
    const reordered = applyGroupOrder(sections, ['unordered', 'best-practices', 'updates']);
    // Someone renames a section in another group meanwhile; the undo keeps that.
    const meanwhile = reordered.map((s) => (s.slug === 'runbooks' ? { ...s, name: 'Runbooks v2' } : s));
    const undone = restoreOrders(meanwhile, sections, slugs);
    expect(undone.find((s) => s.slug === 'updates')?.order).toBe(10);
    expect(undone.find((s) => s.slug === 'best-practices')?.order).toBe(20);
    expect(undone.find((s) => s.slug === 'unordered')).not.toHaveProperty('order');
    expect(undone.find((s) => s.slug === 'runbooks')?.name).toBe('Runbooks v2');
  });

  it('appends a new section to the end of its group', () => {
    expect(nextOrderInGroup(sections, undefined, topics)).toBe(30);
    expect(nextOrderInGroup(sections, 't-ops', topics)).toBe(20);
    expect(nextOrderInGroup(sections, 'default', topics)).toBe(10);
  });
});

describe('one-entry writes over the whole list', () => {
  it('replaces by the original slug in place, or appends', () => {
    const renamed = upsertSection(sections, 'updates', { slug: 'news', name: 'News' });
    expect(renamed.map((s) => s.slug)).toEqual(['best-practices', 'news', 'runbooks', 'adr', 'unordered']);
    expect(upsertSection(sections, null, { slug: 'new', name: 'New' }).at(-1)?.slug).toBe('new');
    expect(upsertSection(sections, 'missing', { slug: 'new', name: 'New' })).toHaveLength(6);
  });

  it('removes and restores, without clobbering a slug created meanwhile', () => {
    const removed = sections.find((s) => s.slug === 'updates')!;
    const without = removeSection(sections, 'updates');
    expect(without).toHaveLength(4);
    expect(restoreSection(without, removed).at(-1)).toEqual(removed);
    const recreated = [...without, { slug: 'updates', name: 'Someone else' }];
    expect(restoreSection(recreated, removed)).toEqual(recreated);
  });

  it('compares by stored meaning, not whitespace or tag order', () => {
    expect(sameSection({ slug: 'a', name: 'A ', tags: ['b', 'a', 'a'] }, { slug: 'a', name: 'A', tags: ['a', 'b'] })).toBe(true);
    expect(sameSection({ slug: 'a', name: 'A', slot: 'none' }, { slug: 'a', name: 'A' })).toBe(true);
    expect(sameSection({ slug: 'a', name: 'A', limit: 5 }, { slug: 'a', name: 'A', limit: 6 })).toBe(false);
    expect(sameSection(undefined, { slug: 'a', name: 'A' })).toBe(false);
  });
});

describe('the draft', () => {
  it('round-trips a stored section', () => {
    const s = { ...sections[2]!, limit: 5 };
    expect(sectionFromDraft(draftFromSection(s), s.order)).toEqual(s);
    // No stored limit shows the site's default, and saving makes it explicit.
    expect(sectionFromDraft(draftFromSection(sections[2]!), 10).limit).toBe(10);
  });

  it('defaults a new draft and derives the slug from the name', () => {
    const d = { ...draftFromSection(undefined), name: 'Release Notes', tags: [' release ', 'release', 'update'] };
    expect(d.limit).toBe(10);
    expect(sectionFromDraft(d, 30)).toEqual({ slug: 'release-notes', name: 'Release Notes', tags: ['release', 'update'], order: 30, limit: 10 });
  });

  it('duplicates with a copy name and a free slug', () => {
    const d = duplicateDraft(sections[1]!, [...sections, { slug: 'updates-copy', name: 'x' }]);
    expect(d.name).toBe('Updates (copy)');
    expect(d.slug).toBe('updates-copy-2');
    expect(d.tags).toEqual(['update']);
  });

  it('validates name, slug and limit, and never blocks on matches', () => {
    const ok = { ...draftFromSection(undefined), name: 'Fresh' };
    expect(hasProblems(validateSection(ok, sections, null))).toBe(false);
    expect(validateSection({ ...ok, name: ' ' }, sections, null)).toEqual({ name: 'Enter a name.' });
    expect(validateSection({ ...ok, slug: 'updates' }, sections, null).slug).toMatch(/already uses \/sections\/updates/);
    // Keeping one's own slug is not a duplicate.
    expect(validateSection({ ...ok, slug: 'updates' }, sections, 'updates').slug).toBeUndefined();
    expect(validateSection({ ...ok, slug: 'Bad Slug' }, sections, null).slug).toMatch(/lowercase/);
    expect(validateSection({ ...ok, name: '!!!' }, sections, null).slug).toMatch(/letter or number/);
    expect(validateSection({ ...ok, limit: 0 }, sections, null).limit).toMatch(/1 to 50/);
    expect(validateSection({ ...ok, limit: 51 }, sections, null).limit).toBeDefined();
    expect(validateSection({ ...ok, limit: '' }, sections, null).limit).toBeDefined();
    expect(validateSection({ ...ok, limit: 2.5 }, sections, null).limit).toBeDefined();
  });
});

describe('content types and slots', () => {
  const types = [
    { key: 'faq', label: 'FAQ' },
    { key: 'blog-post', label: 'Blog Post' },
  ];
  it('resolves a stored type by label or key, like the server', () => {
    expect(findContentTypeLabel('faq', types)).toBe('FAQ');
    expect(findContentTypeLabel('Faq', types)).toBe('FAQ');
    expect(findContentTypeLabel('blog post', types)).toBe('Blog Post');
    expect(findContentTypeLabel('Blog-Post', types)).toBe('Blog Post');
    expect(findContentTypeLabel('runbook', types)).toBeUndefined();
    expect(findContentTypeLabel('', types)).toBeUndefined();
  });

  it('labels slot choices by the heading they render under', () => {
    expect(slotOptionLabel('essential')).toBe('Essential guidance');
    expect(slotOptionLabel('none')).toMatch(/own name/);
    expect(slotOptionLabel('start-here')).toMatch(/Get started/);
  });
});

describe('preview and delete copy', () => {
  it('asks /pages for exactly what the site resolves', () => {
    expect(matchFilters({ type: ' Blog Post ', tags: ['b', 'a'] })).toEqual({ status: 'published', type: 'Blog Post', tags: ['a', 'b'] });
    expect(matchFilters({})).toEqual({ status: 'published' });
  });

  it('says where a section appears', () => {
    expect(appearsOn({ slug: 'updates' }, topics, 'default', true)).toEqual(['Front page (lead)']);
    expect(appearsOn({ slug: 'bp', slot: 'essential' }, topics, 'default', false)).toEqual(['Front page (below the fold, under “Essential guidance”)']);
    expect(appearsOn({ slug: 'r', space: 'operations' }, topics, 'default', false)).toEqual(['Operations landing']);
    expect(appearsOn({ slug: 'd', space: 'default' }, topics, 'default', false)).toEqual(['Default landing', 'Front page (below the fold)']);
    expect(appearsOn({ slug: 'g', space: 'gone' }, topics, 'default', false)[0]).toMatch(/not found/);
  });

  it('names the lead in the delete consequences', () => {
    const c = deleteConsequences(sections[1]!, topics, 'default', true);
    expect(c[0]).toBe('/sections/updates stops working, and links to it break.');
    expect(c[1]).toMatch(/Updates is the front-page lead/);
    expect(c).toContain('It is removed from Front page.');
  });
});

describe('createLimiter', () => {
  it('never runs more than max jobs at once, and runs them all', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const job = (value: number) =>
      limit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return value;
      });
    const results = await Promise.all([1, 2, 3, 4, 5].map(job));
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('keeps going after a job fails', async () => {
    const limit = createLimiter(1);
    const failed = limit(() => Promise.reject(new Error('boom')));
    const next = limit(() => Promise.resolve('ok'));
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });
});
