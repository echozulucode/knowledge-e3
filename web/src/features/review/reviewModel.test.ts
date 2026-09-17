import { describe, expect, it } from 'vitest';
import {
  countOpenReviews,
  groupReviewsBySource,
  openReviewOf,
  reviewDisplayState,
  reviewSourceIds,
  shouldShowReviewNav,
} from './reviewModel.js';
import type { ReviewEntry, SourceStatusView } from '../sources/types.js';

function source(patch: Partial<SourceStatusView>): SourceStatusView {
  return {
    id: 'main',
    space_id: null,
    local_dir: 'main',
    remote_url: null,
    branch: null,
    role: 'authoritative',
    mode: 'direct',
    branch_prefix: 'e3/',
    host_kind: null,
    host_base_url: null,
    host_token_env: null,
    sync_every_seconds: null,
    webhook_secret_env: null,
    default_status: null,
    enabled: 1,
    last_synced_at: null,
    last_error: null,
    status: {
      source: patch.id ?? 'main',
      state: 'idle',
      ahead: 0,
      behind: 0,
      dirty_paths: [],
      conflicted_paths: [],
      last_synced_at: null,
      last_error: null,
    },
    ...patch,
  };
}

function entry(patch: Partial<ReviewEntry> & { state?: 'open' | 'merged' | 'closed'; opened?: string }): ReviewEntry {
  return {
    page_id: patch.page_id ?? 'p1',
    slug: patch.slug ?? 'an-item',
    title: patch.title ?? 'An item',
    review: patch.review ?? {
      state: patch.state ?? 'open',
      url: 'https://github.com/org/repo/pull/7',
      branch: 'e3/an-item-abc123',
      opened_at: patch.opened ?? '2026-09-01T00:00:00.000Z',
    },
  };
}

describe('reviewSourceIds', () => {
  it('asks only the sources whose policy opens change requests', () => {
    const sources = [
      source({ id: 'main', mode: 'direct' }),
      source({ id: 'topic:matlab', mode: 'review' }),
      source({ id: 'topic:vendor', mode: 'read-only' }),
    ];
    expect(reviewSourceIds(sources)).toEqual(['topic:matlab']);
  });
});

describe('groupReviewsBySource', () => {
  it('labels each group with the source remote and sorts open ones first, newest first', () => {
    const sources = [source({ id: 'topic:matlab', mode: 'review', remote_url: 'git@host:org/matlab.git' })];
    const groups = groupReviewsBySource(
      [
        {
          sourceId: 'topic:matlab',
          isLoading: false,
          isError: false,
          reviews: [
            entry({ page_id: 'closed', state: 'closed', opened: '2026-09-05T00:00:00.000Z' }),
            entry({ page_id: 'older', opened: '2026-09-01T00:00:00.000Z' }),
            entry({ page_id: 'newer', opened: '2026-09-04T00:00:00.000Z' }),
          ],
        },
      ],
      sources,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.where).toBe('git@host:org/matlab.git');
    expect(groups[0]?.reviews.map((r) => r.page_id)).toEqual(['newer', 'older', 'closed']);
  });

  it('falls back to the local dir when a source has no remote, and tolerates an unknown source', () => {
    const groups = groupReviewsBySource(
      [{ sourceId: 'topic:x', reviews: [], isLoading: false, isError: true }],
      [source({ id: 'topic:x', mode: 'review', local_dir: 'topics/x' })],
    );
    expect(groups[0]?.where).toBe('topics/x');
    expect(groups[0]?.isError).toBe(true);

    const orphan = groupReviewsBySource([{ sourceId: 'gone', reviews: [], isLoading: false, isError: false }], []);
    expect(orphan[0]?.where).toBe('');
  });
});

describe('countOpenReviews', () => {
  it('counts only the change requests still open', () => {
    expect(
      countOpenReviews([
        { reviews: [entry({ page_id: 'a' }), entry({ page_id: 'b', state: 'merged' })] },
        { reviews: [entry({ page_id: 'c' })] },
      ]),
    ).toBe(2);
    expect(countOpenReviews([])).toBe(0);
  });
});

describe('openReviewOf', () => {
  it('finds the change request on the item, or on its frontmatter', () => {
    const review = { state: 'open' as const, url: 'https://x/1', branch: 'e3/a' };
    expect(openReviewOf({ review })).toBe(review);
    expect(openReviewOf({ frontmatter: { review } })).toBe(review);
  });

  it('ignores merged, closed, absent and missing rows', () => {
    expect(openReviewOf({ review: { state: 'merged', url: 'https://x/1', branch: 'e3/a' } })).toBeNull();
    expect(openReviewOf({ review: { state: 'closed', url: 'https://x/1', branch: 'e3/a' } })).toBeNull();
    expect(openReviewOf({})).toBeNull();
    expect(openReviewOf(null)).toBeNull();
    expect(openReviewOf(undefined)).toBeNull();
  });
});

describe('reviewDisplayState', () => {
  const open = { state: 'open' as const, url: 'https://x/1', branch: 'e3/a' };

  it('lets an open change request override the derived lifecycle state', () => {
    expect(reviewDisplayState('draft', open)).toBe('in-review');
    expect(reviewDisplayState('needs-review', open)).toBe('in-review');
  });

  it('leaves the state alone otherwise', () => {
    expect(reviewDisplayState('published', null)).toBe('published');
    expect(reviewDisplayState(undefined, null)).toBeUndefined();
    expect(reviewDisplayState(null, undefined)).toBeUndefined();
  });
});

describe('shouldShowReviewNav', () => {
  it('always shows the queue to admins', () => {
    expect(shouldShowReviewNav('admin', false)).toBe(true);
  });

  it('shows it to an author only while one of their items is in review', () => {
    expect(shouldShowReviewNav('user', true)).toBe(true);
    expect(shouldShowReviewNav('user', false)).toBe(false);
  });

  it('hides it from anonymous visitors', () => {
    expect(shouldShowReviewNav(undefined, true)).toBe(false);
  });
});
