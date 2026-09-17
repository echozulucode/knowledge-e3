import { describe, expect, it } from 'vitest';
import { splitCodeSpans } from './codeSpans.js';

describe('splitCodeSpans', () => {
  it('splits a backtick-delimited command out of the sentence around it', () => {
    expect(splitCodeSpans('Run `pnpm --filter @echozedlabs/server drill:restore` and schedule it.')).toEqual([
      { kind: 'text', value: 'Run ' },
      { kind: 'code', value: 'pnpm --filter @echozedlabs/server drill:restore' },
      { kind: 'text', value: ' and schedule it.' },
    ]);
  });

  it('handles several spans, and a span at either end', () => {
    expect(splitCodeSpans('`a` then `b`')).toEqual([
      { kind: 'code', value: 'a' },
      { kind: 'text', value: ' then ' },
      { kind: 'code', value: 'b' },
    ]);
  });

  it('renders unbalanced backticks as plain text', () => {
    expect(splitCodeSpans('Run `pnpm drill:restore and schedule it.')).toEqual([
      { kind: 'text', value: 'Run `pnpm drill:restore and schedule it.' },
    ]);
    expect(splitCodeSpans('`a` and `b')).toEqual([{ kind: 'text', value: '`a` and `b' }]);
  });

  it('keeps an empty pair as the literal characters', () => {
    expect(splitCodeSpans('an empty `` pair')).toEqual([{ kind: 'text', value: 'an empty `` pair' }]);
  });

  it('returns plain text untouched, and nothing for nothing', () => {
    expect(splitCodeSpans('Point CONTENT_ROOT at a directory.')).toEqual([
      { kind: 'text', value: 'Point CONTENT_ROOT at a directory.' },
    ]);
    expect(splitCodeSpans('')).toEqual([]);
    expect(splitCodeSpans(null)).toEqual([]);
  });
});
