import { describe, expect, it } from 'vitest';
import { FtsRecencyRanker, type PageCandidate } from '../src/ranker.js';

const NOW = new Date().toISOString();
const FIVE_YEARS_AGO = new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000).toISOString();

function candidate(id: string, over: Partial<PageCandidate> = {}): PageCandidate {
  return { id, slug: id, title: id, updated_at: NOW, fts_rank: 0, ...over };
}

describe('FtsRecencyRanker', () => {
  const ranker = new FtsRecencyRanker();

  it('returns nothing when the query has no free-text signal', () => {
    expect(ranker.score('tag:docker', [candidate('a', { title: 'Docker' })])).toEqual([]);
    expect(ranker.score('', [candidate('a')])).toEqual([]);
  });

  it('ranks title matches above body-only matches regardless of candidate order', () => {
    const ranked = ranker.score('docker', [
      candidate('body', { title: 'Build notes', body: 'docker layers and caching' }),
      candidate('title', { title: 'Docker build cache', body: 'nothing relevant' }),
    ]);

    expect(ranked.map((r) => r.id)).toEqual(['title', 'body']);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it('adds taxonomy weight for tag matches', () => {
    const [tagged, plain] = ranker.score('docker', [
      candidate('tagged', { body: 'docker build', tags: ['docker'] }),
      candidate('plain', { body: 'docker build' }),
    ]);

    expect(tagged!.id).toBe('tagged');
    expect(tagged!.score).toBeGreaterThan(plain!.score);
  });

  it('prefers recently updated pages among otherwise equal matches', () => {
    const ranked = ranker.score('runbook', [
      candidate('old', { title: 'Runbook', updated_at: FIVE_YEARS_AGO }),
      candidate('fresh', { title: 'Runbook', updated_at: NOW }),
    ]);

    expect(ranked.map((r) => r.id)).toEqual(['fresh', 'old']);
  });

  it('rewards an exact phrase in the title over a phrase only in the body', () => {
    const ranked = ranker.score('"cache miss"', [
      candidate('body', { title: 'CI notes', body: 'a cache miss happens when' }),
      candidate('title', { title: 'Cache miss triage', body: 'steps' }),
    ]);

    expect(ranked[0]!.id).toBe('title');
  });
});
