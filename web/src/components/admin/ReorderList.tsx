/**
 * ReorderList / useReorder — change the order of things by dragging, by
 * keyboard, or from a menu (the admin UX review §3.2). Replaces
 * numeric "Order" fields: the parent receives the new id order and persists it
 * (e.g. as 10, 20, 30) - ideally optimistically, then with a Toast + Undo.
 *
 * Three ways in, so nobody is left out:
 *   1. Pointer: drag the handle (mouse, pen, touch - pointer events with
 *      `touch-action: none` on the handle so a touch drag does not scroll).
 *      A line shows where the item will land; Esc during the drag cancels.
 *   2. Keyboard, on the handle ("Reorder <label>"): Space/Enter picks up,
 *      ArrowUp/Down (plus Left/Right in a grid) and Home/End move, Space/Enter
 *      drops, Esc cancels. A live region announces each step
 *      ("Picked up Updates, position 1 of 3" / "Moved to position 2 of 3" / "Dropped …").
 *   3. Menu fallback: `reorder.moveMenuItems(item)` returns "Move to top / up /
 *      down / to bottom" OverflowMenuItems (disabled with a reason at the ends)
 *      to add to the row's `⋯` menu - for switch and voice-control users.
 *
 * Two shapes:
 *   - <ReorderList> renders a list or grid of items itself; `renderItem` gets
 *     the handle to place.
 *   - `useReorder()` when something else renders the rows - e.g. DataTable:
 *       const reorder = useReorder({ items, getId, itemLabel, onReorder });
 *       <DataTable rows={reorder.items} rowDecorator={(row) => reorder.handle(row)} … />
 *       {reorder.announcer}
 *     The row element must carry `data-reorder-item` (DataTable rows do).
 *
 * `onReorder` should update `items` synchronously (optimistic state or query
 * cache); until it does, the list shows the old order.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { OverflowMenuItem } from './OverflowMenu.js';
import {
  countColumns,
  dropSide,
  gridDropIndex,
  keyToReorderCommand,
  listDropIndex,
  moveItem,
  moveMenuEntries,
  reorderReducer,
  type ReorderLayout,
  type ReorderState,
} from './ReorderList.model.js';
import './ReorderList.css';

export { moveItem } from './ReorderList.model.js';

export interface ReorderListProps<T> {
  items: T[];
  getId: (item: T) => string;
  itemLabel: (item: T) => string;
  renderItem: (item: T, handle: ReactNode, index: number) => ReactNode;
  onReorder: (orderedIds: string[]) => void;
  layout?: 'list' | 'grid';
  disabled?: boolean;
  /** Accessible name for the list, e.g. "Front page sections". */
  label?: string;
  /** Extra class on the <ul> (e.g. to set grid columns). */
  className?: string;
}

export interface UseReorderOptions<T> {
  items: T[];
  getId: (item: T) => string;
  itemLabel: (item: T) => string;
  onReorder: (orderedIds: string[]) => void;
  layout?: ReorderLayout;
  disabled?: boolean;
}

export interface UseReorderResult<T> {
  /** Items in display order (the keyboard preview order while one is picked up). */
  items: T[];
  /** The drag handle button for an item. */
  handle: (item: T) => ReactNode;
  /** "Move to top / up / down / to bottom" for the item's overflow menu. */
  moveMenuItems: (item: T) => OverflowMenuItem[];
  /** Live region + handle instructions. Render once, anywhere near the list. */
  announcer: ReactNode;
  /** True while an item is picked up by keyboard or being dragged. */
  active: boolean;
}

interface PointerSession {
  id: string;
  pointerId: number;
  from: number;
  to: number;
  startX: number;
  startY: number;
  dragging: boolean;
  /** Item elements aligned with `ids` (null when an item has no marked element). */
  elements: (HTMLElement | null)[];
}

const DRAG_THRESHOLD_PX = 4;

function itemElementFor(handle: HTMLElement | null | undefined): HTMLElement | null {
  return handle?.closest<HTMLElement>('[data-reorder-item]') ?? null;
}

export function useReorder<T>({ items, getId, itemLabel, onReorder, layout = 'list', disabled = false }: UseReorderOptions<T>): UseReorderResult<T> {
  const instructionsId = useId();
  const ids = useMemo(() => items.map(getId), [items, getId]);
  const byId = useMemo(() => new Map(items.map((item) => [getId(item), item] as const)), [items, getId]);
  const [kbd, setKbd] = useState<ReorderState>({ status: 'idle' });
  const kbdRef = useRef(kbd);
  kbdRef.current = kbd;
  const [announcement, setAnnouncement] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const session = useRef<PointerSession | null>(null);

  // Items changed under a keyboard grab (refetch, someone else's edit): the
  // preview order no longer describes reality, so drop the grab.
  const grabValid = kbd.status === 'grabbed' && kbd.order.length === ids.length && kbd.initialOrder.every((id, i) => id === ids[i]);
  useEffect(() => {
    if (kbd.status === 'grabbed' && !grabValid) setKbd({ status: 'idle' });
  }, [kbd.status, grabValid]);

  const orderedIds = kbd.status === 'grabbed' && grabValid ? kbd.order : ids;
  const orderedItems = useMemo(() => orderedIds.map((id) => byId.get(id)).filter((item): item is T => item !== undefined), [orderedIds, byId]);

  const labelOf = useCallback((id: string) => {
    const item = byId.get(id);
    return item ? itemLabel(item) : id;
  }, [byId, itemLabel]);

  const announce = useCallback((message: string) => {
    // Identical consecutive text is not re-announced; alternate a trailing NBSP.
    setAnnouncement((previous) => (previous === message ? `${message}\u00a0` : message));
  }, []);

  // React may move the focused handle's DOM node when the preview order changes,
  // which blurs it. Put focus back after every keyboard move.
  const grabbedId = kbd.status === 'grabbed' ? kbd.id : null;
  useLayoutEffect(() => {
    if (!grabbedId) return;
    const handle = handles.current.get(grabbedId);
    if (handle && document.activeElement !== handle) handle.focus();
  }, [grabbedId, orderedIds]);

  const clearIndicators = (s: PointerSession | null): void => {
    s?.elements.forEach((el) => {
      el?.removeAttribute('data-drop');
      el?.removeAttribute('data-reorder-dragging');
    });
  };

  const cancelPointer = useCallback(() => {
    const s = session.current;
    if (!s) return;
    clearIndicators(s);
    const handle = handles.current.get(s.id);
    if (handle?.hasPointerCapture(s.pointerId)) handle.releasePointerCapture(s.pointerId);
    session.current = null;
    setDragId(null);
  }, []);

  // Esc cancels a pointer drag or a keyboard grab, and ONLY that: listening on
  // window in the capture phase runs before Modal's document-level Esc handler,
  // so reordering inside a dialog does not also close the dialog.
  useEffect(() => {
    if (!dragId && !grabbedId) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      const s = session.current;
      if (s) {
        cancelPointer();
        announce(`Reorder cancelled. ${labelOf(s.id)} returned to position ${s.from + 1} of ${ids.length}.`);
        return;
      }
      const current = kbdRef.current;
      if (current.status !== 'grabbed') return;
      const step = reorderReducer(current, 'cancel', { ids, focusedId: current.id, columns: 1, labelOf });
      setKbd(step.state);
      if (step.announcement) announce(step.announcement);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [dragId, grabbedId, cancelPointer, announce, labelOf, ids]);

  useEffect(() => () => clearIndicators(session.current), []);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string): void => {
    if (disabled || session.current) return;
    const grabbed = kbd.status === 'grabbed';
    const command = keyToReorderCommand(event.key, layout, grabbed);
    if (!command) return;
    event.preventDefault();
    const columns = layout === 'grid' ? countColumns(ids.map((itemId) => itemElementFor(handles.current.get(itemId))?.getBoundingClientRect().top ?? 0)) : 1;
    const step = reorderReducer(grabbed && grabValid ? kbd : { status: 'idle' }, command, { ids, focusedId: id, columns, labelOf });
    setKbd(step.state);
    if (step.announcement) announce(step.announcement);
    if (step.commit) onReorder(step.commit);
  };

  const onBlur = (id: string): void => {
    if (kbd.status !== 'grabbed' || kbd.id !== id) return;
    // After the re-focus effect has had its chance: if focus really left, cancel.
    requestAnimationFrame(() => {
      const current = kbdRef.current;
      if (current.status !== 'grabbed' || current.id !== id) return;
      if (document.activeElement === handles.current.get(id)) return;
      setKbd({ status: 'idle' });
      announce(`Reorder cancelled. ${labelOf(id)} returned to position ${current.initialOrder.indexOf(id) + 1} of ${current.order.length}.`);
    });
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>, id: string): void => {
    if (disabled || kbd.status === 'grabbed' || event.button !== 0) return;
    const from = ids.indexOf(id);
    if (from < 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    session.current = {
      id,
      pointerId: event.pointerId,
      from,
      to: from,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      elements: ids.map((itemId) => itemElementFor(handles.current.get(itemId))),
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    const s = session.current;
    if (!s || s.pointerId !== event.pointerId) return;
    if (!s.dragging) {
      if (Math.hypot(event.clientX - s.startX, event.clientY - s.startY) < DRAG_THRESHOLD_PX) return;
      s.dragging = true;
      s.elements[s.from]?.setAttribute('data-reorder-dragging', 'true');
      setDragId(s.id);
    }
    event.preventDefault();
    // A missing element measures as NaN, which never wins a comparison.
    const rects = s.elements.map((el) => el?.getBoundingClientRect() ?? { top: NaN, left: NaN, width: NaN, height: NaN });
    const to =
      layout === 'grid'
        ? gridDropIndex(
            { x: event.clientX, y: event.clientY },
            rects.map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })),
            s.from,
          )
        : listDropIndex(
            event.clientY,
            rects.map((r) => r.top + r.height / 2),
            s.from,
          );
    if (to === s.to) return;
    s.elements[s.to]?.removeAttribute('data-drop');
    s.to = to;
    const side = dropSide(s.from, to);
    if (side) s.elements[to]?.setAttribute('data-drop', side);
  };

  const onPointerUp = (event: PointerEvent<HTMLButtonElement>): void => {
    const s = session.current;
    if (!s || s.pointerId !== event.pointerId) return;
    const { dragging, from, to, id } = s;
    cancelPointer();
    if (dragging && to !== from) {
      onReorder(moveItem(ids, from, to));
      announce(`Dropped ${labelOf(id)}, position ${to + 1} of ${ids.length}.`);
    }
  };

  const handle = (item: T): ReactNode => {
    const id = getId(item);
    const label = itemLabel(item);
    const grabbed = kbd.status === 'grabbed' && kbd.id === id;
    return (
      <button
        key={`reorder-handle-${id}`}
        ref={(el) => {
          if (el) handles.current.set(id, el);
          else handles.current.delete(id);
        }}
        type="button"
        className="kp-reorder__handle"
        aria-label={`Reorder ${label}`}
        aria-describedby={instructionsId}
        data-reorder-grabbed={grabbed ? 'true' : undefined}
        disabled={disabled}
        onKeyDown={(e) => onKeyDown(e, id)}
        onBlur={() => onBlur(id)}
        onPointerDown={(e) => onPointerDown(e, id)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancelPointer}
        // pointerup normally ends the session first; this catches a capture lost
        // without one (the handle unmounted, the OS took the pointer).
        onLostPointerCapture={(e) => {
          if (session.current?.pointerId === e.pointerId) cancelPointer();
        }}
        // A tap/click on the handle must not open the row it sits in.
        onClick={(e) => e.stopPropagation()}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
          <circle cx="9" cy="6" r="1.6" />
          <circle cx="15" cy="6" r="1.6" />
          <circle cx="9" cy="12" r="1.6" />
          <circle cx="15" cy="12" r="1.6" />
          <circle cx="9" cy="18" r="1.6" />
          <circle cx="15" cy="18" r="1.6" />
        </svg>
      </button>
    );
  };

  const moveMenuItems = (item: T): OverflowMenuItem[] => {
    const id = getId(item);
    const label = itemLabel(item);
    return moveMenuEntries(ids, id).map((entry) => ({
      id: entry.id,
      label: entry.label,
      disabledReason: disabled ? 'Reordering is unavailable' : entry.disabledReason,
      onSelect: () => {
        const from = ids.indexOf(id);
        const next = moveItem(ids, from, entry.to);
        onReorder(next);
        announce(`Moved ${label} to position ${next.indexOf(id) + 1} of ${ids.length}.`);
      },
    }));
  };

  const hint = layout === 'grid' ? 'arrow keys' : 'up and down arrow keys';
  const announcer = (
    <>
      <span id={instructionsId} className="kp-reorder__vh">
        Press Space or Enter to pick up, the {hint} to move, Space or Enter to drop, Escape to cancel.
      </span>
      <span className="kp-reorder__vh" aria-live="assertive" aria-atomic="true">
        {announcement}
      </span>
    </>
  );

  return { items: orderedItems, handle, moveMenuItems, announcer, active: kbd.status === 'grabbed' || dragId !== null };
}

export function ReorderList<T>({ items, getId, itemLabel, renderItem, onReorder, layout = 'list', disabled = false, label, className }: ReorderListProps<T>): JSX.Element {
  const reorder = useReorder({ items, getId, itemLabel, onReorder, layout, disabled });
  return (
    <div className="kp-reorder" data-layout={layout} data-active={reorder.active ? 'true' : undefined}>
      <ul className={className ? `kp-reorder__list ${className}` : 'kp-reorder__list'} aria-label={label}>
        {reorder.items.map((item, index) => (
          <li key={getId(item)} className="kp-reorder__item" data-reorder-item="">
            {renderItem(item, reorder.handle(item), index)}
          </li>
        ))}
      </ul>
      {reorder.announcer}
    </div>
  );
}
