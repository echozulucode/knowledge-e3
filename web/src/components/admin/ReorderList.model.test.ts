import { describe, expect, it } from 'vitest';
import {
  countColumns,
  dropSide,
  gridDropIndex,
  keyToReorderCommand,
  listDropIndex,
  moveItem,
  moveMenuEntries,
  reorderReducer,
  type ReorderContext,
  type ReorderState,
} from './ReorderList.model.js';

describe('moveItem', () => {
  it('moves forward and backward', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('returns a copy and never mutates', () => {
    const ids = ['a', 'b', 'c'];
    const same = moveItem(ids, 1, 1);
    expect(same).toEqual(ids);
    expect(same).not.toBe(ids);
    moveItem(ids, 0, 2);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('clamps out-of-range indices and handles empty lists', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 99, -5)).toEqual(['c', 'a', 'b']);
    expect(moveItem([], 0, 1)).toEqual([]);
  });
});

describe('keyToReorderCommand', () => {
  it('picks up with Space or Enter even when idle', () => {
    expect(keyToReorderCommand(' ', 'list', false)).toBe('toggle');
    expect(keyToReorderCommand('Enter', 'list', false)).toBe('toggle');
  });

  it('ignores movement keys until picked up', () => {
    expect(keyToReorderCommand('ArrowDown', 'list', false)).toBeNull();
    expect(keyToReorderCommand('Escape', 'list', false)).toBeNull();
  });

  it('maps arrows by layout', () => {
    expect(keyToReorderCommand('ArrowUp', 'list', true)).toBe('prev');
    expect(keyToReorderCommand('ArrowDown', 'list', true)).toBe('next');
    expect(keyToReorderCommand('ArrowLeft', 'list', true)).toBeNull();
    expect(keyToReorderCommand('ArrowUp', 'grid', true)).toBe('up');
    expect(keyToReorderCommand('ArrowDown', 'grid', true)).toBe('down');
    expect(keyToReorderCommand('ArrowLeft', 'grid', true)).toBe('prev');
    expect(keyToReorderCommand('ArrowRight', 'grid', true)).toBe('next');
    expect(keyToReorderCommand('Home', 'list', true)).toBe('first');
    expect(keyToReorderCommand('End', 'grid', true)).toBe('last');
    expect(keyToReorderCommand('Escape', 'grid', true)).toBe('cancel');
  });
});

describe('reorderReducer', () => {
  const labels: Record<string, string> = { u: 'Updates', b: 'Best practices', r: 'Runbooks' };
  const ctx = (focusedId: string, columns = 1): ReorderContext => ({ ids: ['u', 'b', 'r'], focusedId, columns, labelOf: (id) => labels[id] ?? id });
  const idle: ReorderState = { status: 'idle' };

  it('picks up and announces the position', () => {
    const step = reorderReducer(idle, 'toggle', ctx('u'));
    expect(step.state).toEqual({ status: 'grabbed', id: 'u', initialOrder: ['u', 'b', 'r'], order: ['u', 'b', 'r'] });
    expect(step.announcement).toMatch(/^Picked up Updates, position 1 of 3\./);
    expect(step.commit).toBeUndefined();
  });

  it('ignores movement while idle', () => {
    expect(reorderReducer(idle, 'next', ctx('u'))).toEqual({ state: idle });
  });

  it('moves, then drops and commits the new order', () => {
    let state = reorderReducer(idle, 'toggle', ctx('u')).state;
    const moved = reorderReducer(state, 'next', ctx('u'));
    expect(moved.announcement).toBe('Moved to position 2 of 3.');
    expect(moved.commit).toBeUndefined();
    state = moved.state;
    const dropped = reorderReducer(state, 'toggle', ctx('u'));
    expect(dropped.state).toEqual({ status: 'idle' });
    expect(dropped.commit).toEqual(['b', 'u', 'r']);
    expect(dropped.announcement).toBe('Dropped Updates, position 2 of 3.');
  });

  it('does not commit a drop at the starting position', () => {
    let state = reorderReducer(idle, 'toggle', ctx('b')).state;
    state = reorderReducer(state, 'next', ctx('b')).state;
    state = reorderReducer(state, 'prev', ctx('b')).state;
    const dropped = reorderReducer(state, 'toggle', ctx('b'));
    expect(dropped.commit).toBeUndefined();
    expect(dropped.announcement).toBe('Dropped Best practices, position 2 of 3.');
  });

  it('cancels back to the original position without committing', () => {
    let state = reorderReducer(idle, 'toggle', ctx('u')).state;
    state = reorderReducer(state, 'last', ctx('u')).state;
    const cancelled = reorderReducer(state, 'cancel', ctx('u'));
    expect(cancelled.state).toEqual({ status: 'idle' });
    expect(cancelled.commit).toBeUndefined();
    expect(cancelled.announcement).toBe('Reorder cancelled. Updates returned to position 1 of 3.');
  });

  it('stays put at the edges and says so', () => {
    const state = reorderReducer(idle, 'toggle', ctx('u')).state;
    const step = reorderReducer(state, 'prev', ctx('u'));
    expect(step.state).toBe(state);
    expect(step.announcement).toBe("Can't move further. Updates stays at position 1 of 3.");
    expect(reorderReducer(state, 'first', ctx('u')).state).toBe(state);
  });

  it('moves by a row in a grid', () => {
    const grid: ReorderContext = { ids: ['a', 'b', 'c', 'd', 'e', 'f'], focusedId: 'b', columns: 3, labelOf: (id) => id };
    let state = reorderReducer(idle, 'toggle', grid).state;
    const down = reorderReducer(state, 'down', grid);
    expect(down.state.status === 'grabbed' && down.state.order).toEqual(['a', 'c', 'd', 'e', 'b', 'f']);
    state = down.state;
    const up = reorderReducer(state, 'up', grid);
    expect(up.state.status === 'grabbed' && up.state.order).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    // A row up from the first row is out of range.
    expect(reorderReducer(up.state, 'up', grid).state).toBe(up.state);
  });
});

describe('pointer drop maths', () => {
  it('listDropIndex counts other items whose midpoint is above the pointer', () => {
    const mids = [10, 30, 50];
    expect(listDropIndex(40, mids, 0)).toBe(1);
    expect(listDropIndex(60, mids, 0)).toBe(2);
    expect(listDropIndex(20, mids, 2)).toBe(1);
    expect(listDropIndex(0, mids, 2)).toBe(0);
    expect(listDropIndex(35, [10, NaN, 50], 0)).toBe(0);
    expect(moveItem(['a', 'b', 'c'], 0, listDropIndex(40, mids, 0))).toEqual(['b', 'a', 'c']);
  });

  it('gridDropIndex picks the nearest centre', () => {
    const centres = [
      { x: 50, y: 50 },
      { x: 150, y: 50 },
      { x: 50, y: 150 },
    ];
    expect(gridDropIndex({ x: 140, y: 60 }, centres, 0)).toBe(1);
    expect(gridDropIndex({ x: 60, y: 140 }, centres, 0)).toBe(2);
    expect(gridDropIndex({ x: 0, y: 0 }, [], 1)).toBe(1);
  });

  it('countColumns counts items sharing the first top edge', () => {
    expect(countColumns([0, 0, 1, 200, 200])).toBe(3);
    expect(countColumns([0, 60, 120])).toBe(1);
    expect(countColumns([])).toBe(1);
  });

  it('dropSide puts the indicator on the far side of the target', () => {
    expect(dropSide(0, 2)).toBe('after');
    expect(dropSide(2, 0)).toBe('before');
    expect(dropSide(1, 1)).toBeNull();
  });
});

describe('moveMenuEntries', () => {
  it('disables moves past the ends with a visible reason', () => {
    const first = moveMenuEntries(['a', 'b', 'c'], 'a');
    expect(first.map((e) => [e.id, e.disabledReason])).toEqual([
      ['move-top', 'Already first'],
      ['move-up', 'Already first'],
      ['move-down', undefined],
      ['move-bottom', undefined],
    ]);
    const last = moveMenuEntries(['a', 'b', 'c'], 'c');
    expect(last.filter((e) => e.disabledReason).map((e) => e.id)).toEqual(['move-down', 'move-bottom']);
  });

  it('targets the right indices from the middle', () => {
    const middle = moveMenuEntries(['a', 'b', 'c'], 'b');
    expect(middle.map((e) => e.to)).toEqual([0, 0, 2, 2]);
    expect(middle.every((e) => !e.disabledReason)).toBe(true);
  });
});
