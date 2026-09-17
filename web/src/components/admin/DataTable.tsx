/**
 * DataTable — the read-only collection view for admin (the admin UX review §3.2).
 *
 * Use it for any list of records an admin scans and opens: sections, users,
 * sources, tokens, audit events. Rows are NOT editable in place (§3.3: nothing
 * privileged or destructive commits from a table row). Opening a row goes to
 * the edit surface chosen by size:
 *   - ≤ ~5 fields              → EditDialog
 *   - detail with actions      → a side sheet (URL-addressable)
 *   - many/dependent fields or a live preview → an EditPageLayout page (use `rowHref`)
 * Secondary actions go in `rowActions` (an OverflowMenu), never as a row of buttons.
 *
 * Layout: a real <table> when the CONTAINER is ≥ 48rem wide, stacked cards below
 * (container query, so the same table works in a narrow sheet or a wide page).
 * Cards show the `primary` column as the title and the other visible columns as
 * "Label  value" lines; `hideBelow` drops low-value columns first. On cards the
 * header row is gone, so sortable tables get a "Sort by" select instead.
 *
 * States: `state="loading"` with no rows shows a skeleton; with rows it keeps
 * them visible (dimmed, aria-busy) so a refetch never blanks the table.
 * `state="error"` shows the message with Retry. Ready + no rows shows `empty`.
 *
 * Sorting: controlled when `onSortChange` is given (the caller sorts, e.g. on
 * the server); otherwise the table sorts client-side by the column's `sortValue`,
 * starting from `sort`. Only columns with `sortValue` are sortable.
 *
 * Grouping: `groupBy` renders a group header row per group in first-seen order;
 * sorting happens within groups. Reordering: pass `rowDecorator` with the handle
 * from `useReorder` (see ReorderList) and rows in `reorder.items` order.
 */
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { EmptyState } from './EmptyState.js';
import { OverflowMenu, type OverflowMenuItem } from './OverflowMenu.js';
import { ariaSortFor, arrangeRows, isInteractiveTag, nextSort, pageRangeLabel, type SortState } from './DataTable.model.js';
import './DataTable.css';

export interface DataTableColumn<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number;
  hideBelow?: 'md' | 'lg';
  /** Card title on phones; also the cell that becomes the open link/button. Defaults to the first column. */
  primary?: boolean;
  align?: 'start' | 'end';
  width?: string;
}

export interface DataTableProps<T> {
  rows: T[];
  rowKey: (row: T) => string;
  columns: DataTableColumn<T>[];
  /** Accessible table name (visually hidden). */
  caption: string;
  state?: 'loading' | 'error' | 'ready';
  errorMessage?: string;
  onRetry?: () => void;
  /** Rendered when ready and rows.length === 0 (use EmptyState). */
  empty?: ReactNode;
  /** Row click / Enter on the row's primary button. */
  onRowOpen?: (row: T) => void;
  /** Alternative to onRowOpen: the primary cell renders a real link. */
  rowHref?: (row: T) => string;
  /** Renders an OverflowMenu in the last column. */
  rowActions?: (row: T) => OverflowMenuItem[];
  /** Plain-text row name for the actions menu ("Actions for <name>"). Defaults to the primary column's string sortValue. */
  rowLabel?: (row: T) => string;
  groupBy?: (row: T) => { key: string; label: ReactNode };
  sort?: SortState;
  onSortChange?: (s: SortState) => void;
  /** Client-side pagination with "1–50 of N" + Prev/Next when rows exceed it. */
  pageSize?: number;
  /** Search/filter controls above the table. */
  toolbar?: ReactNode;
  /** Leading cell (e.g. a drag handle from useReorder); omitted → no column. */
  rowDecorator?: (row: T) => ReactNode;
  /** aria-current + selected style. */
  selectedKey?: string | null;
}

const SKELETON_ROWS = 4;

export function DataTable<T>(props: DataTableProps<T>): JSX.Element {
  const {
    rows,
    rowKey,
    columns,
    caption,
    state = 'ready',
    errorMessage,
    onRetry,
    empty,
    onRowOpen,
    rowHref,
    rowActions,
    rowLabel,
    groupBy,
    sort,
    onSortChange,
    pageSize,
    toolbar,
    rowDecorator,
    selectedKey,
  } = props;

  const sortSelectId = useId();
  const controlled = onSortChange !== undefined;
  const [internalSort, setInternalSort] = useState<SortState | undefined>(sort);
  const activeSort = controlled ? sort : internalSort;
  const [page, setPage] = useState(0);

  const primaryIndex = Math.max(
    0,
    columns.findIndex((c) => c.primary),
  );
  const primaryColumn = columns[primaryIndex];
  const sortableColumns = columns.filter((c) => c.sortValue);
  const sortColumn = activeSort ? columns.find((c) => c.id === activeSort.columnId) : undefined;

  const arranged = useMemo(
    () =>
      arrangeRows(rows, {
        groupBy,
        // Controlled: the caller already sorted. Client-side: sort by the column.
        sortValue: controlled ? undefined : sortColumn?.sortValue,
        direction: activeSort?.direction,
        pageSize,
        page,
      }),
    [rows, groupBy, controlled, sortColumn, activeSort?.direction, pageSize, page],
  );

  // Keep the page index in range after rows shrink (delete, narrower filter).
  useEffect(() => {
    if (arranged.slice.page !== page) setPage(arranged.slice.page);
  }, [arranged.slice.page, page]);

  const applySort = (next: SortState): void => {
    setPage(0);
    if (controlled) onSortChange(next);
    else setInternalSort(next);
  };

  const labelFor = (row: T): string => {
    if (rowLabel) return rowLabel(row);
    const value = primaryColumn?.sortValue?.(row);
    return typeof value === 'string' && value ? value : 'row';
  };

  const openRow = (event: MouseEvent<HTMLTableRowElement>, row: T): void => {
    if (!onRowOpen && !rowHref) return;
    const target = event.target as HTMLElement;
    // Let real controls in the row (menu button, links, handles) do their own thing.
    for (let el: HTMLElement | null = target; el && el !== event.currentTarget; el = el.parentElement) {
      if (isInteractiveTag(el.tagName, el.getAttribute('role'))) return;
    }
    // Selecting text to copy a slug is not an intent to open.
    if (window.getSelection()?.toString()) return;
    if (rowHref) {
      event.currentTarget.querySelector<HTMLAnchorElement>('a.kp-dt__open')?.click();
    } else {
      onRowOpen?.(row);
    }
  };

  const columnCount = columns.length + (rowDecorator ? 1 : 0) + (rowActions ? 1 : 0);
  const busy = state === 'loading';

  const renderPrimary = (row: T, column: DataTableColumn<T>): ReactNode => {
    const content = column.cell(row);
    if (rowHref) {
      return (
        <Link to={rowHref(row) as never} className="kp-dt__open">
          {content}
        </Link>
      );
    }
    if (onRowOpen) {
      return (
        <button type="button" className="kp-dt__open" onClick={() => onRowOpen(row)}>
          {content}
        </button>
      );
    }
    return content;
  };

  let body: ReactNode;
  if (state === 'error') {
    body = (
      <div className="kp-dt__message" role="alert">
        <p>{errorMessage ?? `Couldn't load ${caption.toLowerCase()}.`}</p>
        {onRetry ? (
          <button type="button" className="kp-dt__button" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    );
  } else if (busy && rows.length === 0) {
    body = (
      <div className="kp-dt__skeleton" role="status">
        <span className="kp-dt__vh">Loading {caption.toLowerCase()}…</span>
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <div key={i} className="kp-dt__skeleton-row" aria-hidden="true" />
        ))}
      </div>
    );
  } else if (rows.length === 0) {
    body = empty ?? <EmptyState title="Nothing here yet" />;
  } else {
    body = (
      <>
        {sortableColumns.length > 0 ? (
          <div className="kp-dt__card-sort">
            <label htmlFor={sortSelectId}>Sort by</label>
            <select
              id={sortSelectId}
              value={activeSort ? `${activeSort.columnId}:${activeSort.direction}` : ''}
              onChange={(e) => {
                const [columnId, direction] = e.target.value.split(':');
                if (columnId && (direction === 'asc' || direction === 'desc')) applySort({ columnId, direction });
              }}
            >
              {activeSort ? null : <option value="">Default order</option>}
              {sortableColumns.flatMap((c) => [
                <option key={`${c.id}:asc`} value={`${c.id}:asc`}>
                  {c.header} (ascending)
                </option>,
                <option key={`${c.id}:desc`} value={`${c.id}:desc`}>
                  {c.header} (descending)
                </option>,
              ])}
            </select>
          </div>
        ) : null}
        <div className="kp-dt__scroll">
          <table className="kp-dt__table" aria-busy={busy || undefined}>
            <caption className="kp-dt__vh">{caption}</caption>
            <thead>
              <tr>
                {rowDecorator ? (
                  <th scope="col" className="kp-dt__decorator-col">
                    <span className="kp-dt__vh">Order</span>
                  </th>
                ) : null}
                {columns.map((column) => {
                  const sortable = Boolean(column.sortValue);
                  const ariaSort = sortable ? ariaSortFor(column.id, activeSort) : undefined;
                  return (
                    <th
                      key={column.id}
                      scope="col"
                      aria-sort={ariaSort === 'none' ? undefined : ariaSort}
                      data-hide={column.hideBelow}
                      data-align={column.align ?? 'start'}
                      style={column.width ? { width: column.width } : undefined}
                    >
                      {sortable ? (
                        <button type="button" className="kp-dt__sort" onClick={() => applySort(nextSort(activeSort, column.id))} data-active={ariaSort !== 'none' ? 'true' : undefined}>
                          {column.header}
                          <SortIcon direction={ariaSort} />
                        </button>
                      ) : (
                        column.header
                      )}
                    </th>
                  );
                })}
                {rowActions ? (
                  <th scope="col" className="kp-dt__actions-col">
                    <span className="kp-dt__vh">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            {arranged.groups.map((group) => (
              <tbody key={group.key}>
                {groupBy ? (
                  <tr className="kp-dt__group">
                    <th scope="rowgroup" colSpan={columnCount}>
                      {group.label}
                    </th>
                  </tr>
                ) : null}
                {group.rows.map((row) => {
                  const key = rowKey(row);
                  const selected = selectedKey != null && selectedKey === key;
                  return (
                    <tr
                      key={key}
                      className="kp-dt__row"
                      data-row-key={key}
                      data-reorder-item=""
                      data-clickable={onRowOpen || rowHref ? 'true' : undefined}
                      data-selected={selected ? 'true' : undefined}
                      aria-current={selected ? 'true' : undefined}
                      onClick={(e) => openRow(e, row)}
                    >
                      {rowDecorator ? <td className="kp-dt__decorator">{rowDecorator(row)}</td> : null}
                      {columns.map((column, index) => {
                        const isPrimary = index === primaryIndex;
                        return (
                          <td
                            key={column.id}
                            data-label={column.header}
                            data-primary={isPrimary ? 'true' : undefined}
                            data-hide={column.hideBelow}
                            data-align={column.align ?? 'start'}
                          >
                            {isPrimary ? renderPrimary(row, column) : column.cell(row)}
                          </td>
                        );
                      })}
                      {rowActions ? (
                        <td className="kp-dt__actions">
                          <OverflowMenu label={`Actions for ${labelFor(row)}`} items={rowActions(row)} />
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
        {arranged.slice.pageCount > 1 ? (
          <nav className="kp-dt__pager" aria-label={`${caption} pages`}>
            <span className="kp-dt__range" aria-live="polite">
              {pageRangeLabel(arranged.slice)}
            </span>
            <button type="button" className="kp-dt__button" onClick={() => setPage(arranged.slice.page - 1)} disabled={arranged.slice.page === 0}>
              Previous
            </button>
            <button type="button" className="kp-dt__button" onClick={() => setPage(arranged.slice.page + 1)} disabled={arranged.slice.page >= arranged.slice.pageCount - 1}>
              Next
            </button>
          </nav>
        ) : null}
      </>
    );
  }

  return (
    <div className="kp-dt" data-state={state}>
      {toolbar ? <div className="kp-dt__toolbar">{toolbar}</div> : null}
      <div className="kp-dt__body">{body}</div>
    </div>
  );
}

function SortIcon({ direction }: { direction: 'ascending' | 'descending' | 'none' | undefined }): JSX.Element {
  return (
    <svg className="kp-dt__sort-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {direction === 'ascending' ? <polyline points="6 15 12 9 18 15" /> : direction === 'descending' ? <polyline points="6 9 12 15 18 9" /> : <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />}
    </svg>
  );
}
