import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { renderHighlighted } from './renderHighlighted.js';

const html = (text: string | null | undefined, ranges: unknown) => renderToStaticMarkup(<>{renderHighlighted(text, ranges)}</>);

describe('renderHighlighted', () => {
  it('wraps matched ranges in <mark>', () => {
    expect(html('Modbus gateway', [[0, 6]])).toBe('<mark class="kp-mark">Modbus</mark> gateway');
  });

  it('renders plain text when there is nothing (valid) to mark', () => {
    expect(html('Modbus gateway', undefined)).toBe('Modbus gateway');
    expect(html('Modbus gateway', [[0, 'x']])).toBe('Modbus gateway');
    expect(html(null, [[0, 1]])).toBe('');
  });

  it('escapes the text — ranges can never smuggle markup in', () => {
    expect(html('<b>x</b>', [[3, 4]])).toBe('&lt;b&gt;<mark class="kp-mark">x</mark>&lt;/b&gt;');
  });

  it('marks an astral character whole', () => {
    expect(html('a 🚀 b', [[3, 4]])).toBe('a <mark class="kp-mark">🚀</mark> b');
  });
});
