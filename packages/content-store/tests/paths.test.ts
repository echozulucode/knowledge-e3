import { describe, it, expect } from 'vitest';
import { conceptDirFor, isReservedPath, slugFromPath, toPosix } from '../src/paths.js';

describe('toPosix', () => {
  it('converts backslashes and leaves posix paths alone', () => {
    expect(toPosix('topic\\concepts\\a.md')).toBe('topic/concepts/a.md');
    expect(toPosix('concepts/a.md')).toBe('concepts/a.md');
  });
});

describe('isReservedPath', () => {
  const reserved = ['index.md', 'log.md'];
  it('matches on basename in any directory', () => {
    expect(isReservedPath('index.md', reserved)).toBe(true);
    expect(isReservedPath('topic/concepts/log.md', reserved)).toBe(true);
    expect(isReservedPath('topic\\index.md', reserved)).toBe(true);
    expect(isReservedPath('concepts/indexing.md', reserved)).toBe(false);
  });
});

describe('slugFromPath', () => {
  it('strips directories and the .md suffix only', () => {
    expect(slugFromPath('topic/concepts/my-page.md')).toBe('my-page');
    expect(slugFromPath('concepts\\a.b.md')).toBe('a.b');
    expect(slugFromPath('concepts/notes.txt')).toBe('notes.txt');
  });
});

describe('conceptDirFor', () => {
  it('mirrors the routing adapter layouts', () => {
    expect(conceptDirFor('kaykit', { dedicated: true })).toBe('concepts');
    expect(conceptDirFor(null, { dedicated: true })).toBe('concepts');
    expect(conceptDirFor('kaykit', { dedicated: false })).toBe('kaykit/concepts');
    expect(conceptDirFor(null, { dedicated: false })).toBe('default/concepts');
  });
});
