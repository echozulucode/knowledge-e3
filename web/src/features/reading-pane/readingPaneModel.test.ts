import { describe, expect, it } from 'vitest';
import {
  READING_PANE_MIN_INLINE_REM,
  isEditableTarget,
  isPlainPrimaryClick,
  isWideReadingInline,
  peekFromSearch,
  peekHistoryMode,
  shouldEscapeClosePane,
  validatePeekSearch,
  withPeek,
} from './readingPaneModel.js';

const click = (overrides: Partial<Parameters<typeof isPlainPrimaryClick>[0]> = {}) => ({
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  ...overrides,
});

describe('reading pane threshold', () => {
  it('opens at exactly the threshold, measured in rem', () => {
    expect(isWideReadingInline(READING_PANE_MIN_INLINE_REM * 16, 16)).toBe(true);
    expect(isWideReadingInline(READING_PANE_MIN_INLINE_REM * 16 - 1, 16)).toBe(false);
  });

  it('follows the root font size, so a larger default text size needs a wider route', () => {
    expect(isWideReadingInline(1800, 16)).toBe(true);
    expect(isWideReadingInline(1800, 20)).toBe(false);
  });

  it('falls back to 16px for an unreadable root font size, and refuses a nonsense width', () => {
    expect(isWideReadingInline(1760, Number.NaN)).toBe(true);
    expect(isWideReadingInline(Number.NaN, 16)).toBe(false);
  });
});

describe('peek search param', () => {
  it('reads a slug, a JSON-decoded number, and nothing else', () => {
    expect(peekFromSearch({ q: 'mqtt', peek: 'broker-setup' })).toBe('broker-setup');
    expect(peekFromSearch({ peek: 2024 })).toBe('2024');
    expect(peekFromSearch({ peek: '  ' })).toBeUndefined();
    expect(peekFromSearch({ peek: { slug: 'x' } })).toBeUndefined();
    expect(peekFromSearch(undefined)).toBeUndefined();
  });

  it('validates to only the peek key, so the router merge keeps every other param', () => {
    expect(validatePeekSearch({ q: 'mqtt', tag: ['a', 'b'], peek: 'x' })).toEqual({ peek: 'x' });
    expect(validatePeekSearch({ q: 'mqtt' })).toEqual({});
  });

  it('sets, replaces and removes peek without touching or duplicating the rest', () => {
    const search = { q: 'mqtt', tag: ['a', 'b'], peek: 'old' };
    expect(withPeek(search, 'new')).toEqual({ q: 'mqtt', tag: ['a', 'b'], peek: 'new' });
    expect(withPeek(search, undefined)).toEqual({ q: 'mqtt', tag: ['a', 'b'] });
    expect(withPeek(undefined, 'x')).toEqual({ peek: 'x' });
    expect(search.peek).toBe('old');
  });
});

describe('history policy', () => {
  it('pushes an open from closed and a close, so Back undoes either', () => {
    expect(peekHistoryMode(undefined, 'a')).toBe('push');
    expect(peekHistoryMode('a', undefined)).toBe('push');
  });

  it('replaces when choosing another row, but pushes when reading onward from inside the article', () => {
    expect(peekHistoryMode('a', 'b', 'list')).toBe('replace');
    expect(peekHistoryMode('a', 'b', 'pane')).toBe('push');
  });

  it('does nothing for the item that is already open', () => {
    expect(peekHistoryMode('a', 'a')).toBe('none');
    expect(peekHistoryMode(undefined, undefined)).toBe('none');
    expect(peekHistoryMode('', undefined)).toBe('none');
  });
});

describe('click predicate', () => {
  it('takes a plain primary click', () => {
    expect(isPlainPrimaryClick(click())).toBe(true);
    expect(isPlainPrimaryClick(click(), { target: '_self' })).toBe(true);
  });

  it('leaves modifier, middle and handled clicks to the browser', () => {
    expect(isPlainPrimaryClick(click({ metaKey: true }))).toBe(false);
    expect(isPlainPrimaryClick(click({ ctrlKey: true }))).toBe(false);
    expect(isPlainPrimaryClick(click({ shiftKey: true }))).toBe(false);
    expect(isPlainPrimaryClick(click({ altKey: true }))).toBe(false);
    expect(isPlainPrimaryClick(click({ button: 1 }))).toBe(false);
    expect(isPlainPrimaryClick(click({ defaultPrevented: true }))).toBe(false);
  });

  it('leaves a link that targets another window, or downloads, alone', () => {
    expect(isPlainPrimaryClick(click(), { target: '_blank' })).toBe(false);
    expect(isPlainPrimaryClick(click(), { download: true })).toBe(false);
  });
});

describe('Escape', () => {
  const base = {
    key: 'Escape',
    modifiers: false,
    defaultPrevented: false,
    focus: { tagName: 'A' },
    focusWithinLayout: true,
    focusOnBody: false,
    modalOpen: false,
  };

  it('closes from the list, the pane, or no particular focus', () => {
    expect(shouldEscapeClosePane(base)).toBe(true);
    expect(shouldEscapeClosePane({ ...base, focus: { tagName: 'BODY' }, focusWithinLayout: false, focusOnBody: true })).toBe(true);
  });

  it('never steals Escape from a field, a dialog, the header, or another handler', () => {
    expect(shouldEscapeClosePane({ ...base, focus: { tagName: 'input' } })).toBe(false);
    expect(shouldEscapeClosePane({ ...base, focus: { tagName: 'SELECT' } })).toBe(false);
    expect(shouldEscapeClosePane({ ...base, focus: { tagName: 'DIV', isContentEditable: true } })).toBe(false);
    expect(shouldEscapeClosePane({ ...base, modalOpen: true })).toBe(false);
    expect(shouldEscapeClosePane({ ...base, focusWithinLayout: false })).toBe(false);
    expect(shouldEscapeClosePane({ ...base, defaultPrevented: true })).toBe(false);
    expect(shouldEscapeClosePane({ ...base, modifiers: true })).toBe(false);
    expect(shouldEscapeClosePane({ ...base, key: 'Enter' })).toBe(false);
  });

  it('knows which elements are editable', () => {
    expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
