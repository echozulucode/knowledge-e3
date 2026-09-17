import { describe, expect, it } from 'vitest';
import { addKey, buildRows, createRowLabel, isUnknownValue, matchesQuery, moveActive, removeKey, removeLastKey } from './referencePickerModel.js';

interface Opt {
  key: string;
  label: string;
}
const options: Opt[] = [
  { key: 'blog-post', label: 'Blog Post' },
  { key: 'faq', label: 'FAQ' },
  { key: 'runbook', label: 'Runbook' },
  { key: 'faq', label: 'FAQ duplicate' },
];
const base = { options, getKey: (o: Opt) => o.key, getLabel: (o: Opt) => o.label, idPrefix: 'p' };

describe('filtering', () => {
  it('matches label or key, case-insensitively', () => {
    expect(matchesQuery('Blog Post', 'blog-post', 'POST')).toBe(true);
    expect(matchesQuery('Blog Post', 'blog-post', 'g-p')).toBe(true);
    expect(matchesQuery('FAQ', 'faq', 'run')).toBe(false);
    expect(matchesQuery('FAQ', 'faq', '  ')).toBe(true);
  });

  it('lists options once, with the empty option first in single mode', () => {
    const rows = buildRows({ ...base, query: '', selected: [], multiple: false, emptyOptionLabel: 'Any type' });
    expect(rows.map((r) => r.label)).toEqual(['Any type', 'Blog Post', 'FAQ', 'Runbook']);
    expect(rows[0]).toMatchObject({ kind: 'empty', id: 'p-empty' });
  });

  it('hides the empty option while searching, and never shows it in multiple mode', () => {
    expect(buildRows({ ...base, query: 'f', selected: [], multiple: false, emptyOptionLabel: 'Any' }).map((r) => r.label)).toEqual(['FAQ']);
    expect(buildRows({ ...base, query: '', selected: [], multiple: true, emptyOptionLabel: 'Any' })[0]!.kind).toBe('option');
  });

  it('leaves chosen keys out in multiple mode only', () => {
    expect(buildRows({ ...base, query: '', selected: ['faq'], multiple: true }).map((r) => r.label)).toEqual(['Blog Post', 'Runbook']);
    expect(buildRows({ ...base, query: '', selected: ['faq'], multiple: false })).toHaveLength(3);
  });

  it('caps the option rows', () => {
    expect(buildRows({ ...base, query: '', selected: [], multiple: true, max: 2 })).toHaveLength(2);
  });
});

describe('the Create row', () => {
  it('offers to create a value nobody has', () => {
    const rows = buildRows({ ...base, query: ' release ', selected: [], multiple: true, allowCreate: true });
    expect(rows.at(-1)).toEqual({ kind: 'create', id: 'p-create', key: 'release', label: 'Create “release”' });
  });

  it('does not offer an existing option, a chosen chip, a blank query, or when creation is off', () => {
    expect(createRowLabel({ ...base, query: 'Faq', selected: [], allowCreate: true })).toBeUndefined();
    expect(createRowLabel({ ...base, query: 'blog post', selected: [], allowCreate: true })).toBeUndefined();
    expect(createRowLabel({ ...base, query: 'News', selected: ['news'], allowCreate: true })).toBeUndefined();
    expect(createRowLabel({ ...base, query: '   ', selected: [], allowCreate: true })).toBeUndefined();
    expect(createRowLabel({ ...base, query: 'news', selected: [], allowCreate: false })).toBeUndefined();
  });
});

describe('chips', () => {
  it('adds once, trims, ignores blanks', () => {
    expect(addKey(['a'], ' b ')).toEqual(['a', 'b']);
    expect(addKey(['a'], 'a')).toEqual(['a']);
    expect(addKey(['a'], '  ')).toEqual(['a']);
    // Case is meaningful for stored tags.
    expect(addKey(['update'], 'Update')).toEqual(['update', 'Update']);
  });

  it('removes one, or the last', () => {
    expect(removeKey(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    expect(removeLastKey(['a', 'b'])).toEqual(['a']);
    expect(removeLastKey([])).toEqual([]);
  });
});

describe('keyboard and stored values', () => {
  it('wraps arrow movement', () => {
    expect(moveActive(-1, 1, 3)).toBe(0);
    expect(moveActive(-1, -1, 3)).toBe(2);
    expect(moveActive(2, 1, 3)).toBe(0);
    expect(moveActive(0, -1, 3)).toBe(2);
    expect(moveActive(0, 1, 0)).toBe(-1);
  });

  it('flags a stored value missing from the options', () => {
    expect(isUnknownValue('gone', options, base.getKey)).toBe(true);
    expect(isUnknownValue('faq', options, base.getKey)).toBe(false);
    expect(isUnknownValue('', options, base.getKey)).toBe(false);
  });
});
