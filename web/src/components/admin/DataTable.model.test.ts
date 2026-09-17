import { describe, expect, it } from 'vitest';
import {
  ariaSortFor,
  arrangeRows,
  compareSortValues,
  groupRows,
  isInteractiveTag,
  nextSort,
  pageRangeLabel,
  paginate,
  sortRows,
} from './DataTable.model.js';

interface Row {
  id: string;
  name: string;
  limit: number;
  place: string;
}

const rows: Row[] = [
  { id: 'a', name: 'Updates', limit: 12, place: 'front' },
  { id: 'b', name: 'runbooks', limit: 5, place: 'ops' },
  { id: 'c', name: 'Best practices', limit: 10, place: 'front' },
  { id: 'd', name: 'Item 10', limit: 5, place: 'ops' },
  { id: 'e', name: 'Item 2', limit: 5, place: 'front' },
];
const ids = (list: Row[]): string[] => list.map((r) => r.id);

describe('compareSortValues', () => {
  it('compares numbers numerically and sorts NaN last', () => {
    expect([10, 2, NaN, 1].sort(compareSortValues)).toEqual([1, 2, 10, NaN]);
  });

  it('compares strings naturally and case-insensitively', () => {
    expect(['Item 10', 'item 2', 'Alpha'].sort(compareSortValues)).toEqual(['Alpha', 'item 2', 'Item 10']);
  });
});

describe('sortRows', () => {
  it('sorts ascending and descending without mutating the input', () => {
    const input = rows.slice();
    expect(ids(sortRows(input, (r) => r.name, 'asc'))).toEqual(['c', 'e', 'd', 'b', 'a']);
    expect(ids(sortRows(input, (r) => r.name, 'desc'))).toEqual(['a', 'b', 'd', 'e', 'c']);
    expect(input).toEqual(rows);
  });

  it('is stable for equal keys in both directions', () => {
    expect(ids(sortRows(rows, (r) => r.limit, 'asc'))).toEqual(['b', 'd', 'e', 'c', 'a']);
    expect(ids(sortRows(rows, (r) => r.limit, 'desc'))).toEqual(['a', 'c', 'b', 'd', 'e']);
  });

  it('returns a copy in input order without a sortValue', () => {
    const out = sortRows(rows, undefined, 'asc');
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });
});

describe('nextSort / ariaSortFor', () => {
  it('toggles the same column and starts a new column ascending', () => {
    expect(nextSort(undefined, 'name')).toEqual({ columnId: 'name', direction: 'asc' });
    expect(nextSort({ columnId: 'name', direction: 'asc' }, 'name')).toEqual({ columnId: 'name', direction: 'desc' });
    expect(nextSort({ columnId: 'name', direction: 'desc' }, 'name')).toEqual({ columnId: 'name', direction: 'asc' });
    expect(nextSort({ columnId: 'name', direction: 'desc' }, 'limit')).toEqual({ columnId: 'limit', direction: 'asc' });
  });

  it('maps sort state to aria-sort', () => {
    expect(ariaSortFor('name', undefined)).toBe('none');
    expect(ariaSortFor('name', { columnId: 'limit', direction: 'asc' })).toBe('none');
    expect(ariaSortFor('name', { columnId: 'name', direction: 'asc' })).toBe('ascending');
    expect(ariaSortFor('name', { columnId: 'name', direction: 'desc' })).toBe('descending');
  });
});

describe('groupRows', () => {
  it('keeps groups in first-seen order', () => {
    const groups = groupRows(rows, (r) => ({ key: r.place, label: r.place.toUpperCase() }));
    expect(groups.map((g) => g.key)).toEqual(['front', 'ops']);
    expect(groups.map((g) => g.label)).toEqual(['FRONT', 'OPS']);
    expect(groups.map((g) => ids(g.rows))).toEqual([
      ['a', 'c', 'e'],
      ['b', 'd'],
    ]);
  });

  it('puts everything in one unlabeled group without groupBy', () => {
    const groups = groupRows(rows, undefined);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBeUndefined();
    expect(ids(groups[0]!.rows)).toEqual(ids(rows));
  });
});

describe('paginate / pageRangeLabel', () => {
  const many = Array.from({ length: 120 }, (_, i) => i);

  it('returns a single page when rows fit or pageSize is absent', () => {
    expect(paginate(many, undefined, 3)).toMatchObject({ page: 0, pageCount: 1, start: 0, end: 120, total: 120 });
    expect(paginate([1, 2], 50, 0)).toMatchObject({ pageCount: 1, end: 2 });
    expect(paginate(many, 0, 0).pageCount).toBe(1);
  });

  it('slices pages and labels the range', () => {
    const first = paginate(many, 50, 0);
    expect(first.rows).toHaveLength(50);
    expect(pageRangeLabel(first)).toBe('1–50 of 120');
    const last = paginate(many, 50, 2);
    expect(last.rows).toEqual(many.slice(100));
    expect(pageRangeLabel(last)).toBe('101–120 of 120');
    expect(last.pageCount).toBe(3);
  });

  it('clamps a page past the end (after a delete) and below zero', () => {
    expect(paginate(many, 50, 9).page).toBe(2);
    expect(paginate(many, 50, -1).page).toBe(0);
  });

  it('labels an empty collection', () => {
    expect(pageRangeLabel(paginate([], 50, 0))).toBe('0 of 0');
  });
});

describe('arrangeRows', () => {
  const byPlace = (r: Row) => ({ key: r.place, label: r.place });

  it('sorts within groups without reordering the groups', () => {
    const { groups } = arrangeRows(rows, { groupBy: byPlace, sortValue: (r) => r.name, direction: 'desc' });
    expect(groups.map((g) => g.key)).toEqual(['front', 'ops']);
    expect(groups.map((g) => ids(g.rows))).toEqual([
      ['a', 'e', 'c'],
      ['b', 'd'],
    ]);
  });

  it('paginates the grouped order and repeats the group header on a later page', () => {
    const { groups, slice } = arrangeRows(rows, { groupBy: byPlace, pageSize: 2, page: 1 });
    // Flattened grouped order: a c e | b d → page 2 is [e, b].
    expect(ids(slice.rows)).toEqual(['e', 'b']);
    expect(groups.map((g) => g.key)).toEqual(['front', 'ops']);
    expect(pageRangeLabel(slice)).toBe('3–4 of 5');
  });

  it('works without grouping or sorting', () => {
    const { groups, slice } = arrangeRows(rows, {});
    expect(groups).toHaveLength(1);
    expect(ids(slice.rows)).toEqual(ids(rows));
  });
});

describe('isInteractiveTag', () => {
  it('treats controls and control roles as interactive', () => {
    expect(isInteractiveTag('BUTTON', null)).toBe(true);
    expect(isInteractiveTag('a', null)).toBe(true);
    expect(isInteractiveTag('div', 'menuitem')).toBe(true);
    expect(isInteractiveTag('span', 'checkbox')).toBe(true);
  });

  it('treats plain content as row-clickable', () => {
    expect(isInteractiveTag('td', null)).toBe(false);
    expect(isInteractiveTag('span', null)).toBe(false);
    expect(isInteractiveTag('div', 'presentation')).toBe(false);
  });
});
