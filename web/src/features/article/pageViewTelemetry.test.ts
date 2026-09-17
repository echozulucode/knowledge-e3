import { describe, expect, it } from 'vitest';
import { pageViewToSend } from './pageViewTelemetry.js';

describe('pageViewToSend', () => {
  it('sends the first view of an article', () => {
    expect(pageViewToSend(null, 'page-1')).toBe('page-1');
  });

  it('does not send the same article twice (StrictMode double effects, re-renders)', () => {
    expect(pageViewToSend('page-1', 'page-1')).toBeNull();
  });

  it('sends again when a different article is opened in the same reader', () => {
    expect(pageViewToSend('page-1', 'page-2')).toBe('page-2');
  });

  it('sends nothing before the article has loaded', () => {
    expect(pageViewToSend(null, undefined)).toBeNull();
    expect(pageViewToSend('page-1', null)).toBeNull();
  });
});
