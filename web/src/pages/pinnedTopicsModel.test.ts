import { describe, expect, it } from 'vitest';
import {
  DARK_COVER_NEEDS_COVER,
  MAX_PINNED_TOPICS,
  PinWriteRefused,
  canAddPin,
  cleanPin,
  orderPins,
  pinCountLabel,
  pinDialogProblems,
  pinMatchesTopic,
  pinRowProblems,
  pinnableTopics,
  removePin,
  restorePin,
  upsertPin,
} from './pinnedTopicsModel.js';

describe('pinned topics editor rules', () => {
  it('caps the list at the server’s six', () => {
    expect(MAX_PINNED_TOPICS).toBe(6);
    expect(canAddPin(0)).toBe(true);
    expect(canAddPin(5)).toBe(true);
    expect(canAddPin(6)).toBe(false);
    expect(canAddPin(7)).toBe(false);
    expect(pinCountLabel(4)).toBe('4 of 6');
  });

  it('flags a dark cover with no cover, and only that', () => {
    expect(
      pinRowProblems([
        { cover: '/assets/a.png', cover_dark: '/assets/a-dark.png' },
        { cover: '', cover_dark: '/assets/b-dark.png' },
        { cover: '/assets/c.png', cover_dark: '' },
        {},
        { cover: '   ', cover_dark: ' /assets/e-dark.png ' },
        { cover: '', cover_dark: '   ' },
      ]),
    ).toEqual({ 1: DARK_COVER_NEEDS_COVER, 4: DARK_COVER_NEEDS_COVER });
  });
});

describe('pinned topics page model', () => {
  const topics = [
    { id: 't1', slug: 'ops', name: 'Operations' },
    { id: 't2', slug: 'arch', name: 'Architecture', visibility: 'private' as const },
    { id: 't3', slug: 'research', name: 'Research' },
  ];

  it('offers only unpinned topics, keeping the one being edited', () => {
    const pins = [{ topic: 'ops' }, { topic: 't2' }];
    expect(pinnableTopics(topics, pins, null).map((t) => t.slug)).toEqual(['research']);
    expect(pinnableTopics(topics, pins, 'ops').map((t) => t.slug)).toEqual(['ops', 'research']);
    expect(pinMatchesTopic({ topic: 't2' }, topics[1]!)).toBe(true);
  });

  it('cleans a pin the way the server stores it', () => {
    expect(cleanPin({ topic: ' ops ', color: '', icon: 'wrench', cover: ' ', cover_dark: '/assets/d.png' })).toEqual({ topic: 'ops', icon: 'wrench' });
    expect(cleanPin({ topic: 'ops', cover: '/assets/a.png', cover_dark: '/assets/d.png' })).toEqual({ topic: 'ops', cover: '/assets/a.png', cover_dark: '/assets/d.png' });
  });

  it('flags a missing topic and a dark cover alone', () => {
    expect(pinDialogProblems({ topic: '' })).toEqual({ topic: 'Choose a topic.' });
    expect(pinDialogProblems({ topic: 'ops', cover_dark: '/assets/d.png' })).toEqual({ cover_dark: DARK_COVER_NEEDS_COVER });
    expect(pinDialogProblems({ topic: 'ops', cover: '/assets/a.png', cover_dark: '/assets/d.png' })).toEqual({});
  });

  it('adds, replaces in place, and refuses a seventh pin or a duplicate', () => {
    const pins = [{ topic: 'ops' }, { topic: 'arch' }];
    expect(upsertPin(pins, null, { topic: 'research', color: 'teal' })).toEqual([...pins, { topic: 'research', color: 'teal' }]);
    expect(upsertPin(pins, 'ops', { topic: 'research' })).toEqual([{ topic: 'research' }, { topic: 'arch' }]);
    expect(upsertPin(pins, 'ops', { topic: 'ops', icon: 'book' })[0]).toEqual({ topic: 'ops', icon: 'book' });
    expect(() => upsertPin(pins, null, { topic: 'arch' })).toThrow(PinWriteRefused);
    expect(() => upsertPin(pins, 'ops', { topic: 'arch' })).toThrow(/already pinned/);
    const full = ['a', 'b', 'c', 'd', 'e', 'f'].map((topic) => ({ topic }));
    expect(() => upsertPin(full, null, { topic: 'g' })).toThrow(/already features 6/);
    expect(upsertPin(full, 'a', { topic: 'g' })[0]).toEqual({ topic: 'g' });
  });

  it('unpins and restores at the old position, unless re-pinned or full', () => {
    const pins = [{ topic: 'a' }, { topic: 'b' }, { topic: 'c' }];
    const without = removePin(pins, 'b');
    expect(without).toEqual([{ topic: 'a' }, { topic: 'c' }]);
    expect(restorePin(without, { topic: 'b' }, 1)).toEqual(pins);
    expect(restorePin(pins, { topic: 'b' }, 1)).toEqual(pins);
    const full = ['a', 'c', 'd', 'e', 'f', 'g'].map((topic) => ({ topic }));
    expect(restorePin(full, { topic: 'b' }, 1)).toEqual(full);
    expect(restorePin(without, { topic: 'b' }, 99).at(-1)).toEqual({ topic: 'b' });
  });

  it('orders pins by topic, keeping unnamed ones after in their order', () => {
    const pins = [{ topic: 'a' }, { topic: 'b' }, { topic: 'c' }, { topic: 'd' }];
    expect(orderPins(pins, ['c', 'a']).map((p) => p.topic)).toEqual(['c', 'a', 'b', 'd']);
    expect(orderPins(pins, ['d', 'c', 'b', 'a']).map((p) => p.topic)).toEqual(['d', 'c', 'b', 'a']);
  });
});
