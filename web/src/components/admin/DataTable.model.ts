/**
 * Pure arrangement logic for DataTable: sort, group, paginate.
 *
 * Kept out of the component so it runs under the node-only vitest environment
 * (there is no DOM in web unit tests). The component only renders what these
 * functions return.
 *
 * Order of operations, and why:
 *   1. group in first-seen order of the INPUT rows - the caller decides which
 *      group comes first (e.g. "Front page" before topic groups) by the order
 *      it passes rows in; sorting must never shuffle groups;
 *   2. sort within each group (stable, so equal keys keep the caller's order);
 *   3. paginate the flattened result, then regroup the visible slice so a group
 *      header repeats at the top of every page that contains its rows.
 */

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  columnId: string;
  direction: SortDirection;
}

export type SortValue = string | number;

/** Numbers compare numerically; strings compare naturally ("item 2" < "item 10") and case-insensitively. */
export function compareSortValues(a: SortValue, b: SortValue): number {
  if (typeof a === 'number' && typeof b === 'number') {
    // NaN sorts last rather than poisoning the comparator.
    if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : 1;
    if (Number.isNaN(b)) return -1;
    return a - b;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Stable sort; returns a new array and never mutates `rows`. */
export function sortRows<T>(rows: readonly T[], sortValue: ((row: T) => SortValue) | undefined, direction: SortDirection): T[] {
  if (!sortValue) return rows.slice();
  const sign = direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, key: sortValue(row) }))
    .sort((a, b) => compareSortValues(a.key, b.key) * sign || a.index - b.index)
    .map((entry) => entry.row);
}

/** Header click: same column flips direction, a new column starts ascending. */
export function nextSort(current: SortState | undefined, columnId: string): SortState {
  if (current && current.columnId === columnId) {
    return { columnId, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { columnId, direction: 'asc' };
}

export function ariaSortFor(columnId: string, sort: SortState | undefined): 'ascending' | 'descending' | 'none' {
  if (!sort || sort.columnId !== columnId) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

export interface RowGroup<T, L> {
  key: string;
  label: L;
  rows: T[];
}

/** Groups in first-seen order. Without `groupBy`, one unlabeled group holds everything. */
export function groupRows<T, L>(rows: readonly T[], groupBy: ((row: T) => { key: string; label: L }) | undefined): RowGroup<T, L | undefined>[] {
  if (!groupBy) return [{ key: '__all__', label: undefined, rows: rows.slice() }];
  const groups = new Map<string, RowGroup<T, L | undefined>>();
  for (const row of rows) {
    const { key, label } = groupBy(row);
    let group = groups.get(key);
    if (!group) {
      group = { key, label, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return Array.from(groups.values());
}

export interface PageSlice<T> {
  rows: T[];
  /** Zero-based page actually shown (clamped into range). */
  page: number;
  pageCount: number;
  /** Zero-based index of the first visible row. */
  start: number;
  /** Exclusive end index. */
  end: number;
  total: number;
}

/** Client-side pagination. No/invalid `pageSize` → a single page. */
export function paginate<T>(rows: readonly T[], pageSize: number | undefined, page: number): PageSlice<T> {
  const total = rows.length;
  if (!pageSize || pageSize <= 0 || total <= pageSize) {
    return { rows: rows.slice(), page: 0, pageCount: 1, start: 0, end: total, total };
  }
  const pageCount = Math.ceil(total / pageSize);
  // Clamp: a delete or a narrower filter can leave the old page past the end.
  const safePage = Math.min(Math.max(0, Math.floor(page)), pageCount - 1);
  const start = safePage * pageSize;
  const end = Math.min(start + pageSize, total);
  return { rows: rows.slice(start, end), page: safePage, pageCount, start, end, total };
}

/** "1–50 of 120". */
export function pageRangeLabel(slice: Pick<PageSlice<unknown>, 'start' | 'end' | 'total'>): string {
  if (slice.total === 0) return '0 of 0';
  return `${slice.start + 1}–${slice.end} of ${slice.total}`;
}

export interface ArrangeOptions<T, L> {
  groupBy?: (row: T) => { key: string; label: L };
  sortValue?: (row: T) => SortValue;
  direction?: SortDirection;
  pageSize?: number;
  page?: number;
}

export interface ArrangedRows<T, L> {
  groups: RowGroup<T, L | undefined>[];
  slice: PageSlice<T>;
}

/** The whole pipeline: group → sort within group → paginate → regroup the page. */
export function arrangeRows<T, L>(rows: readonly T[], options: ArrangeOptions<T, L>): ArrangedRows<T, L> {
  const direction = options.direction ?? 'asc';
  const grouped = groupRows(rows, options.groupBy).map((group) => ({
    ...group,
    rows: sortRows(group.rows, options.sortValue, direction),
  }));
  const flat = grouped.flatMap((group) => group.rows.map((row) => ({ row, group })));
  const slice = paginate(flat, options.pageSize, options.page ?? 0);

  const pageGroups = new Map<string, RowGroup<T, L | undefined>>();
  for (const { row, group } of slice.rows) {
    let pageGroup = pageGroups.get(group.key);
    if (!pageGroup) {
      pageGroup = { key: group.key, label: group.label, rows: [] };
      pageGroups.set(group.key, pageGroup);
    }
    pageGroup.rows.push(row);
  }
  return {
    groups: Array.from(pageGroups.values()),
    slice: { ...slice, rows: slice.rows.map((entry) => entry.row) },
  };
}

/**
 * Should a click on the row open it? Not when the click landed on (or inside)
 * another interactive control, and not when the person was selecting text.
 */
export function isInteractiveTag(tagName: string, role: string | null): boolean {
  const tag = tagName.toLowerCase();
  if (['a', 'button', 'input', 'select', 'textarea', 'label', 'summary', 'details'].includes(tag)) return true;
  return role !== null && ['button', 'link', 'menuitem', 'checkbox', 'switch', 'menu', 'option', 'textbox', 'combobox'].includes(role);
}
