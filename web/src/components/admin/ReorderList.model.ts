/**
 * Pure reorder logic shared by ReorderList and useReorder: the move helper, the
 * keyboard "pick up / move / drop" reducer with its announcements, and the
 * pointer drop-index maths. No React, no DOM - unit-testable under node.
 */

/** Move the entry at `from` to `to` (both clamped). Returns a new array. */
export function moveItem<T>(ids: readonly T[], from: number, to: number): T[] {
  const next = ids.slice();
  if (next.length === 0) return next;
  const src = Math.min(Math.max(0, from), next.length - 1);
  const dst = Math.min(Math.max(0, to), next.length - 1);
  if (src === dst) return next;
  const [entry] = next.splice(src, 1);
  next.splice(dst, 0, entry as T);
  return next;
}

export type ReorderLayout = 'list' | 'grid';

export type ReorderCommand = 'toggle' | 'prev' | 'next' | 'up' | 'down' | 'first' | 'last' | 'cancel';

/**
 * Map a key on a reorder handle to a command. Arrow/Home/End keys only mean
 * something while an item is picked up, so Tab and arrows stay normal otherwise.
 */
export function keyToReorderCommand(key: string, layout: ReorderLayout, grabbed: boolean): ReorderCommand | null {
  if (key === ' ' || key === 'Spacebar' || key === 'Enter') return 'toggle';
  if (!grabbed) return null;
  switch (key) {
    case 'Escape':
      return 'cancel';
    case 'ArrowUp':
      return layout === 'grid' ? 'up' : 'prev';
    case 'ArrowDown':
      return layout === 'grid' ? 'down' : 'next';
    case 'ArrowLeft':
      return layout === 'grid' ? 'prev' : null;
    case 'ArrowRight':
      return layout === 'grid' ? 'next' : null;
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    default:
      return null;
  }
}

export type ReorderState =
  | { status: 'idle' }
  | {
      status: 'grabbed';
      id: string;
      /** Order when the item was picked up - what Esc restores and what "changed?" compares against. */
      initialOrder: string[];
      /** Live preview order while moving. */
      order: string[];
    };

export interface ReorderContext {
  /** Current committed ids, in order. */
  ids: readonly string[];
  /** The id whose handle received the key. */
  focusedId: string;
  /** Items per row in grid layout (1 for lists). */
  columns: number;
  labelOf: (id: string) => string;
}

export interface ReorderStep {
  state: ReorderState;
  /** Set on a drop that changed the order: the parent persists it. */
  commit?: string[];
  announcement?: string;
}

const position = (index: number, count: number): string => `position ${index + 1} of ${count}`;

export function reorderReducer(state: ReorderState, command: ReorderCommand, ctx: ReorderContext): ReorderStep {
  if (state.status === 'idle') {
    if (command !== 'toggle') return { state };
    const index = ctx.ids.indexOf(ctx.focusedId);
    if (index < 0) return { state };
    const order = ctx.ids.slice();
    return {
      state: { status: 'grabbed', id: ctx.focusedId, initialOrder: order, order },
      announcement: `Picked up ${ctx.labelOf(ctx.focusedId)}, ${position(index, order.length)}. Use the arrow keys to move, Space to drop, Escape to cancel.`,
    };
  }

  const { id, order, initialOrder } = state;
  const count = order.length;
  const current = order.indexOf(id);
  const label = ctx.labelOf(id);

  if (command === 'cancel') {
    return {
      state: { status: 'idle' },
      announcement: `Reorder cancelled. ${label} returned to ${position(initialOrder.indexOf(id), count)}.`,
    };
  }

  if (command === 'toggle') {
    const changed = order.some((value, i) => value !== initialOrder[i]);
    return {
      state: { status: 'idle' },
      ...(changed ? { commit: order } : {}),
      announcement: `Dropped ${label}, ${position(current, count)}.`,
    };
  }

  const columns = Math.max(1, Math.floor(ctx.columns));
  const target = (() => {
    switch (command) {
      case 'prev':
        return current - 1;
      case 'next':
        return current + 1;
      case 'up':
        return current - columns;
      case 'down':
        return current + columns;
      case 'first':
        return 0;
      case 'last':
        return count - 1;
    }
  })();

  if (target < 0 || target >= count || target === current) {
    // Repeating the same text would be swallowed by the live region, so the
    // caller toggles a trailing space; the wording itself stays stable.
    return { state, announcement: `Can't move further. ${label} stays at ${position(current, count)}.` };
  }

  return {
    state: { ...state, order: moveItem(order, current, target) },
    announcement: `Moved to ${position(target, count)}.`,
  };
}

/**
 * List pointer drag: the final index = how many OTHER items have their vertical
 * midpoint above the pointer. Feed straight into `moveItem(ids, from, result)`.
 */
export function listDropIndex(pointer: number, midpoints: readonly number[], from: number): number {
  let count = 0;
  midpoints.forEach((mid, index) => {
    if (index !== from && mid < pointer) count++;
  });
  return count;
}

/** Grid pointer drag: the item whose centre is nearest the pointer. */
export function gridDropIndex(pointer: { x: number; y: number }, centres: readonly { x: number; y: number }[], from: number): number {
  let best = from;
  let bestDistance = Number.POSITIVE_INFINITY;
  centres.forEach((centre, index) => {
    const distance = (centre.x - pointer.x) ** 2 + (centre.y - pointer.y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** Items per row: how many items share the first item's top edge (±2px). */
export function countColumns(tops: readonly number[]): number {
  if (tops.length === 0) return 1;
  const first = tops[0]!;
  let columns = 0;
  for (const top of tops) {
    if (Math.abs(top - first) <= 2) columns++;
    else break;
  }
  return Math.max(1, columns);
}

/** Which side of the target the drop indicator sits on, for a move from → to. */
export function dropSide(from: number, to: number): 'before' | 'after' | null {
  if (from === to) return null;
  return to > from ? 'after' : 'before';
}

export interface MoveMenuEntry {
  id: 'move-top' | 'move-up' | 'move-down' | 'move-bottom';
  label: string;
  to: number;
  disabledReason?: string;
}

/** The "Move up / down" menu fallback for people who can use neither drag nor the keyboard handle. */
export function moveMenuEntries(ids: readonly string[], id: string): MoveMenuEntry[] {
  const index = ids.indexOf(id);
  const last = ids.length - 1;
  const first = index <= 0;
  const isLast = index >= last;
  const entries: MoveMenuEntry[] = [
    { id: 'move-top', label: 'Move to top', to: 0 },
    { id: 'move-up', label: 'Move up', to: index - 1 },
    { id: 'move-down', label: 'Move down', to: index + 1 },
    { id: 'move-bottom', label: 'Move to bottom', to: last },
  ];
  return entries.map((entry) => {
    const towardStart = entry.id === 'move-top' || entry.id === 'move-up';
    if (towardStart ? first : isLast) return { ...entry, disabledReason: towardStart ? 'Already first' : 'Already last' };
    return entry;
  });
}
