import { describe, expect, it } from 'vitest';
import { queueRowLink } from './queueRowLink.js';

const review = (url: string | null) => ({ state: 'closed' as const, url, branch: 'e3/x', opened_at: null, closed_at: null });

describe('queueRowLink', () => {
  it('opens a live queue member in Compose', () => {
    expect(queueRowLink('untyped', { slug: 'checklist', review: null })).toEqual({ kind: 'edit', slug: 'checklist' });
    // A review ref on a live item does not change where the fix happens.
    expect(queueRowLink('lint_failed_inbound', { slug: 'checklist', review: review('https://git.example/pr/7') })).toEqual({
      kind: 'edit',
      slug: 'checklist',
    });
  });

  it('points a declined removal at the change request, never at the deleted item’s editor', () => {
    expect(
      queueRowLink('declined_removal_still_deleted', { slug: 'checklist', review: review('https://git.example/pr/7') }),
    ).toEqual({ kind: 'change-request', url: 'https://git.example/pr/7' });
  });

  it('shows a declined removal with no usable URL as text', () => {
    expect(queueRowLink('declined_removal_still_deleted', { slug: 'checklist', review: null })).toEqual({ kind: 'text' });
    expect(queueRowLink('declined_removal_still_deleted', { slug: 'checklist', review: review(null) })).toEqual({ kind: 'text' });
    expect(queueRowLink('declined_removal_still_deleted', { slug: 'checklist', review: review('javascript:alert(1)') })).toEqual({
      kind: 'text',
    });
  });
});
