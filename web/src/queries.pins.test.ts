import { describe, expect, it } from 'vitest';
import { pinInputFromView } from './queries.js';

describe('pinInputFromView', () => {
  it('turns the resolved pin back into what the PUT takes', () => {
    expect(
      pinInputFromView({ topic: 'ops', name: 'Operations', color: 'teal', icon: 'wrench', cover: '/assets/a.png', cover_dark: '/assets/d.png' }),
    ).toEqual({ topic: 'ops', color: 'teal', icon: 'wrench', cover: '/assets/a.png', cover_dark: '/assets/d.png' });
  });

  it('reads a dark cover equal to the cover as none set (the server’s fallback)', () => {
    expect(pinInputFromView({ topic: 'ops', cover: '/assets/a.png', cover_dark: '/assets/a.png' })).toEqual({ topic: 'ops', cover: '/assets/a.png' });
    expect(pinInputFromView({ topic: 'ops', name: null, color: null, icon: null, cover: null, cover_dark: null })).toEqual({ topic: 'ops' });
  });
});
