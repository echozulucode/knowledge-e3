/**
 * B1 degrades with the server's redaction ladder rather than breaking against
 * it. Each case below is one rung of `redactSourceForViewer`.
 */
import { describe, expect, it } from 'vitest';
import { itemLocation } from './itemLocation.js';

const full = {
  id: 'topic:matlab',
  role: 'authoritative' as const,
  mode: 'direct' as const,
  path: 'concepts/simulink-bus.md',
  url: 'https://github.com/org/matlab/blob/main/concepts/simulink-bus.md',
};

describe('itemLocation', () => {
  it('gives an admin the id, the path and the door', () => {
    expect(itemLocation(full)).toEqual({
      id: 'topic:matlab',
      path: 'concepts/simulink-bus.md',
      url: 'https://github.com/org/matlab/blob/main/concepts/simulink-bus.md',
    });
  });

  it('gives a signed-in reader the door without the path', () => {
    expect(itemLocation({ ...full, path: null })).toEqual({ id: 'topic:matlab', path: null, url: full.url });
  });

  it('shows nothing to a viewer who was given neither — an anonymous read, or a source with no addressable remote', () => {
    expect(itemLocation({ ...full, path: null, url: null })).toBeNull();
    expect(itemLocation(null)).toBeNull();
    expect(itemLocation(undefined)).toBeNull();
  });

  it('treats a blank path or url as absent rather than rendering an empty row', () => {
    expect(itemLocation({ ...full, path: '  ', url: '' })).toBeNull();
  });
});
