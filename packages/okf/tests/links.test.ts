import { describe, it, expect } from 'vitest';
import { translateLinks } from '../src/links.js';

const resolve = (title: string) =>
  title === 'Customers' ? '/concepts/customers.md' : undefined;

describe('translateLinks', () => {
  it('renders a dual link by default (wiki-link kept + markdown link appended)', () => {
    const out = translateLinks('See [[Customers]] for joins.', resolve, 'dual');
    expect(out).toBe('See [[Customers]] ([Customers](/concepts/customers.md)) for joins.');
  });

  it('renders a markdown-only link when asked', () => {
    const out = translateLinks('See [[Customers]] for joins.', resolve, 'markdown');
    expect(out).toBe('See [Customers](/concepts/customers.md) for joins.');
  });

  it('leaves the body untouched in preserve mode', () => {
    const body = 'See [[Customers]] for joins.';
    expect(translateLinks(body, resolve, 'preserve')).toBe(body);
  });

  it('leaves unresolved targets in place (OKF tolerates broken links)', () => {
    const out = translateLinks('See [[Unknown Page]] here.', resolve, 'markdown');
    expect(out).toBe('See [[Unknown Page]] here.');
  });

  it('does not translate wiki-link syntax inside fenced code', () => {
    const body = 'Text [[Customers]]\n\n```\ncode [[Customers]] stays\n```\n';
    const out = translateLinks(body, resolve, 'markdown');
    expect(out).toContain('[Customers](/concepts/customers.md)');
    expect(out).toContain('code [[Customers]] stays');
  });

  it('translates multiple occurrences correctly', () => {
    const out = translateLinks('[[Customers]] and again [[Customers]].', resolve, 'markdown');
    expect(out).toBe('[Customers](/concepts/customers.md) and again [Customers](/concepts/customers.md).');
  });
});
