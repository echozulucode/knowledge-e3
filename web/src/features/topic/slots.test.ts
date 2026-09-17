import { describe, it, expect } from 'vitest';
import type { SectionView } from '@echozedlabs/knowledge-types';
import { orderPortalSections, orderSections, pickHomeTopic, pickUpdatesSection } from './slots.js';

function section(over: Partial<SectionView> & { name: string }): SectionView {
  return { slug: over.name.toLowerCase().replace(/\s+/g, '-'), ...over };
}

describe('orderPortalSections', () => {
  it('renders slots in the fixed order, then unslotted sections under their own names', () => {
    const out = orderPortalSections([
      section({ name: 'Deep dives', slot: 'advanced', order: 1 }),
      section({ name: 'Tips', order: 2 }),
      section({ name: 'Gotchas', slot: 'limitations' }),
      section({ name: 'Basics', slot: 'essential', order: 9 }),
      section({ name: 'FAQ', slot: 'none', order: 1 }),
      section({ name: 'Wins', slot: 'examples' }),
      section({ name: 'Recent', slot: 'latest' }),
    ]);
    expect(out.map((o) => o.heading)).toEqual([
      'Essential guidance',
      'Examples / What worked',
      'Known limitations',
      'Latest',
      'Advanced',
      'FAQ',
      'Tips',
    ]);
    expect(out.map((o) => o.section.name)).toEqual(['Basics', 'Wins', 'Gotchas', 'Recent', 'Deep dives', 'FAQ', 'Tips']);
  });

  it('keeps several sections in one slot in their own order and skips start-here', () => {
    const out = orderPortalSections([
      section({ name: 'B', slot: 'essential', order: 2 }),
      section({ name: 'A', slot: 'essential', order: 1 }),
      section({ name: 'Intro', slot: 'start-here' }),
    ]);
    expect(out.map((o) => o.section.name)).toEqual(['A', 'B']);
  });

  it('returns nothing for no sections', () => {
    expect(orderPortalSections([])).toEqual([]);
  });
});

describe('orderSections', () => {
  it('sorts by order, unordered last, ties by name', () => {
    const out = orderSections([section({ name: 'Zed' }), section({ name: 'Two', order: 2 }), section({ name: 'One', order: 1 }), section({ name: 'Alpha' })]);
    expect(out.map((s) => s.name)).toEqual(['One', 'Two', 'Alpha', 'Zed']);
  });
});

describe('pickHomeTopic', () => {
  it('prefers the default topic, else the first visible one', () => {
    expect(pickHomeTopic([{ slug: 'a' }, { slug: 'default' }, { slug: 'b' }])?.slug).toBe('default');
    expect(pickHomeTopic([{ slug: 'a' }, { slug: 'b' }])?.slug).toBe('a');
    expect(pickHomeTopic([])).toBeUndefined();
  });

  it('prefers the topic site.homeTopic names, and falls back when it does not resolve', () => {
    const topics = [{ slug: 'a' }, { slug: 'default' }, { slug: 'ai' }];
    expect(pickHomeTopic(topics, 'ai')?.slug).toBe('ai');
    // A configured slug the viewer cannot see must not leave the site homeless.
    expect(pickHomeTopic(topics, 'private')?.slug).toBe('default');
    expect(pickHomeTopic(topics, null)?.slug).toBe('default');
  });
});

describe('pickUpdatesSection', () => {
  it('leads with the lowest order, whatever the tenant called it', () => {
    // Not "the one named Updates": a tenant who calls it "News", "Announcements" or "From
    // the shop floor" must get the same layout, and `order` already means
    // "this one first" everywhere else.
    const { lead, rest } = pickUpdatesSection([
      section({ name: 'Essential guidance', order: 3 }),
      section({ name: 'Announcements', order: 0 }),
      section({ name: 'What worked', order: 1 }),
    ]);
    expect(lead?.name).toBe('Announcements');
    expect(rest.map((s) => s.name)).toEqual(['What worked', 'Essential guidance']);
  });

  it('sorts unordered sections after ordered ones, ties by name', () => {
    const { lead, rest } = pickUpdatesSection([section({ name: 'Zed' }), section({ name: 'Alpha' })]);
    expect(lead?.name).toBe('Alpha');
    expect(rest.map((s) => s.name)).toEqual(['Zed']);
  });

  it('has no lead when nothing resolved — the fresh-instance state', () => {
    expect(pickUpdatesSection([])).toEqual({ rest: [] });
    expect(pickUpdatesSection(undefined)).toEqual({ rest: [] });
  });
});
