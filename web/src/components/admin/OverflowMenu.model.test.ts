import { describe, expect, it } from 'vitest';
import { isTypeaheadKey, menuKeyTarget, openKeyTarget, placeMenu, typeaheadIndex } from './OverflowMenu.model.js';

describe('menuKeyTarget', () => {
  it('wraps arrow keys', () => {
    expect(menuKeyTarget('ArrowDown', 2, 3)).toEqual({ type: 'focus', index: 0 });
    expect(menuKeyTarget('ArrowUp', 0, 3)).toEqual({ type: 'focus', index: 2 });
    expect(menuKeyTarget('ArrowDown', 0, 3)).toEqual({ type: 'focus', index: 1 });
  });

  it('starts from the ends when nothing is active', () => {
    expect(menuKeyTarget('ArrowDown', -1, 3)).toEqual({ type: 'focus', index: 0 });
    expect(menuKeyTarget('ArrowUp', -1, 3)).toEqual({ type: 'focus', index: 2 });
  });

  it('jumps with Home/End', () => {
    expect(menuKeyTarget('Home', 2, 4)).toEqual({ type: 'focus', index: 0 });
    expect(menuKeyTarget('End', 0, 4)).toEqual({ type: 'focus', index: 3 });
  });

  it('closes on Escape and Tab, ignores other keys', () => {
    expect(menuKeyTarget('Escape', 1, 3)).toEqual({ type: 'close' });
    expect(menuKeyTarget('Tab', 1, 3)).toEqual({ type: 'close' });
    expect(menuKeyTarget('x', 1, 3)).toEqual({ type: 'none' });
    expect(menuKeyTarget('ArrowDown', 0, 0)).toEqual({ type: 'none' });
  });
});

describe('openKeyTarget', () => {
  it('opens on the first item for Enter/Space/ArrowDown and the last for ArrowUp', () => {
    expect(openKeyTarget('Enter', 3)).toBe(0);
    expect(openKeyTarget(' ', 3)).toBe(0);
    expect(openKeyTarget('ArrowDown', 3)).toBe(0);
    expect(openKeyTarget('ArrowUp', 3)).toBe(2);
    expect(openKeyTarget('a', 3)).toBeNull();
    expect(openKeyTarget('Enter', 0)).toBeNull();
  });
});

describe('typeaheadIndex', () => {
  const labels = ['Edit', 'View on site', 'Duplicate', 'Delete…'];

  it('finds the next item starting with a letter, wrapping', () => {
    expect(typeaheadIndex(labels, 0, 'd')).toBe(2);
    expect(typeaheadIndex(labels, 2, 'd')).toBe(3);
    expect(typeaheadIndex(labels, 3, 'd')).toBe(2);
    expect(typeaheadIndex(labels, 3, 'E')).toBe(0);
  });

  it('matches a multi-letter prefix, including the current item', () => {
    expect(typeaheadIndex(labels, 3, 'de')).toBe(3);
    expect(typeaheadIndex(labels, 0, 'du')).toBe(2);
  });

  it('cycles on a repeated letter and returns -1 on no match', () => {
    expect(typeaheadIndex(labels, 2, 'dd')).toBe(3);
    expect(typeaheadIndex(labels, 0, 'z')).toBe(-1);
    expect(typeaheadIndex([], 0, 'a')).toBe(-1);
  });
});

describe('isTypeaheadKey', () => {
  const none = { ctrlKey: false, metaKey: false, altKey: false };
  it('accepts printable characters only, without modifiers', () => {
    expect(isTypeaheadKey('d', none)).toBe(true);
    expect(isTypeaheadKey(' ', none)).toBe(false);
    expect(isTypeaheadKey('ArrowDown', none)).toBe(false);
    expect(isTypeaheadKey('d', { ...none, ctrlKey: true })).toBe(false);
  });
});

describe('placeMenu', () => {
  const viewport = { width: 1000, height: 800 };
  const menu = { width: 200, height: 160 };

  it('opens below, end-aligned to the trigger', () => {
    const trigger = { top: 100, bottom: 140, left: 500, right: 540 };
    expect(placeMenu(trigger, menu, viewport, 'end')).toEqual({ top: 144, left: 340, above: false });
    expect(placeMenu(trigger, menu, viewport, 'start')).toEqual({ top: 144, left: 500, above: false });
  });

  it('flips above when there is no room below', () => {
    const trigger = { top: 740, bottom: 780, left: 500, right: 540 };
    expect(placeMenu(trigger, menu, viewport, 'end')).toEqual({ top: 576, left: 340, above: true });
  });

  it('keeps the menu inside the viewport horizontally', () => {
    const nearLeft = { top: 100, bottom: 140, left: 0, right: 40 };
    expect(placeMenu(nearLeft, menu, viewport, 'end').left).toBe(8);
    const nearRight = { top: 100, bottom: 140, left: 980, right: 1000 };
    expect(placeMenu(nearRight, menu, viewport, 'start').left).toBe(792);
  });
});
