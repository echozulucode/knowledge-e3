import { describe, expect, it } from 'vitest';
import { interceptedItemSlug, type ClickLike } from './itemLinkIntercept.js';

const ORIGIN = 'https://hub.example';
const plain: ClickLike = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };

describe('interceptedItemSlug', () => {
  it('takes a plain left-click on an item link', () => {
    expect(interceptedItemSlug(plain, { href: '/p/getting-started' }, ORIGIN)).toBe('getting-started');
    expect(interceptedItemSlug(plain, { href: '/p/getting-started/' }, ORIGIN)).toBe('getting-started');
    expect(interceptedItemSlug(plain, { href: '/p/getting-started#install' }, ORIGIN)).toBe('getting-started');
    expect(interceptedItemSlug(plain, { href: `${ORIGIN}/p/runbook` }, ORIGIN)).toBe('runbook');
    expect(interceptedItemSlug(plain, { href: '/p/caf%C3%A9', target: '_self' }, ORIGIN)).toBe('café');
  });

  it('leaves modifier clicks to the browser (new tab, new window, download)', () => {
    for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
      expect(interceptedItemSlug({ ...plain, [key]: true }, { href: '/p/runbook' }, ORIGIN)).toBeNull();
    }
  });

  it('leaves middle and right clicks alone', () => {
    expect(interceptedItemSlug({ ...plain, button: 1 }, { href: '/p/runbook' }, ORIGIN)).toBeNull();
    expect(interceptedItemSlug({ ...plain, button: 2 }, { href: '/p/runbook' }, ORIGIN)).toBeNull();
  });

  it('does not take a click something else already handled', () => {
    expect(interceptedItemSlug({ ...plain, defaultPrevented: true }, { href: '/p/runbook' }, ORIGIN)).toBeNull();
  });

  it('leaves links that open elsewhere alone', () => {
    expect(interceptedItemSlug(plain, { href: '/p/runbook', target: '_blank' }, ORIGIN)).toBeNull();
    expect(interceptedItemSlug(plain, { href: '/p/runbook', download: true }, ORIGIN)).toBeNull();
  });

  it('leaves external links alone, even ones shaped like an item path', () => {
    expect(interceptedItemSlug(plain, { href: 'https://elsewhere.example/p/runbook' }, ORIGIN)).toBeNull();
    expect(interceptedItemSlug(plain, { href: '//elsewhere.example/p/runbook' }, ORIGIN)).toBeNull();
    expect(interceptedItemSlug(plain, { href: 'mailto:someone@example.com' }, ORIGIN)).toBeNull();
  });

  it('leaves non-item links to navigate: search, tags, topics, series, Compose', () => {
    for (const href of ['/search?tag=ops', '/search?topic=platform', '/topics/platform', '/series/getting-started', '/p/runbook/edit', '/p/', '/items/abc', '#section']) {
      expect(interceptedItemSlug(plain, { href }, ORIGIN)).toBeNull();
    }
  });

  it('ignores anchors without an href', () => {
    expect(interceptedItemSlug(plain, { href: null }, ORIGIN)).toBeNull();
    expect(interceptedItemSlug(plain, { href: '' }, ORIGIN)).toBeNull();
  });
});
