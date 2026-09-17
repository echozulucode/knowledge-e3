import { describe, expect, it } from 'vitest';
import { headingOutline } from './headingOutline.js';

describe('headingOutline', () => {
  it('lists H1–H3 in source order with ReadView-compatible ids', () => {
    const body = ['# Overview', 'Prose.', '## Install the CLI', '### On macOS', '#### Too deep', 'More.'].join('\n');
    expect(headingOutline(body)).toEqual([
      { depth: 1, text: 'Overview', id: 'overview' },
      { depth: 2, text: 'Install the CLI', id: 'install-the-cli' },
      { depth: 3, text: 'On macOS', id: 'on-macos' },
    ]);
  });

  it('skips heading-shaped lines inside fenced code', () => {
    const body = ['## Real', '```bash', '# a shell comment, not a heading', '```', '## Also real'].join('\n');
    expect(headingOutline(body).map((e) => e.text)).toEqual(['Real', 'Also real']);
  });

  it('strips inline markup and closing hashes from the text', () => {
    expect(headingOutline('## The `config` **file** ##')).toEqual([{ depth: 2, text: 'The config file', id: 'the-config-file' }]);
  });

  it('needs a space after the hashes, and tolerates empty input', () => {
    expect(headingOutline('#hashtag\n##\n')).toEqual([]);
    expect(headingOutline('')).toEqual([]);
    expect(headingOutline(undefined)).toEqual([]);
  });
});
