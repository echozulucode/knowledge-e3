import { describe, expect, it } from 'vitest';
import { TOPIC_SLUG_MAX, createTopicBody, slugifyTopic, topicSlugProblem, visibilityForRepoUrl } from './topicCreateModel.js';

describe('slugifyTopic', () => {
  it('matches the server: lowercase ASCII, hyphens for runs of anything else, trimmed', () => {
    expect(slugifyTopic('  Product Discovery!  ')).toBe('product-discovery');
    expect(slugifyTopic('C++ & Rust -- notes')).toBe('c-rust-notes');
  });

  it('folds diacritics the way the server does', () => {
    expect(slugifyTopic('Café Opérations')).toBe('cafe-operations');
  });

  it('is empty for input with no letters or numbers, and capped at the column length', () => {
    expect(slugifyTopic('!!!')).toBe('');
    expect(slugifyTopic('a'.repeat(150))).toHaveLength(TOPIC_SLUG_MAX);
  });
});

describe('topicSlugProblem', () => {
  const existing = [{ slug: 'handbook' }];

  it('accepts a free slug', () => {
    expect(topicSlugProblem('operations', existing)).toBeNull();
  });

  it('names a clash with a listed topic, and an empty slug', () => {
    expect(topicSlugProblem('handbook', existing)).toBe('Another topic already uses /topics/handbook.');
    expect(topicSlugProblem('', existing)).toMatch(/at least one letter or number/);
  });
});

describe('visibilityForRepoUrl', () => {
  it('preselects Private once a repository URL is entered, and Public again when it is cleared', () => {
    expect(visibilityForRepoUrl('git@host:org/topic.git', 'public', false)).toBe('private');
    expect(visibilityForRepoUrl('   ', 'private', false)).toBe('public');
    expect(visibilityForRepoUrl('', 'public', false)).toBe('public');
  });

  it('never overrides a visibility the admin chose', () => {
    expect(visibilityForRepoUrl('git@host:org/topic.git', 'public', true)).toBe('public');
    expect(visibilityForRepoUrl('', 'private', true)).toBe('private');
  });
});

describe('createTopicBody', () => {
  const base = { name: ' Handbook ', slug: '', description: '', visibility: 'public' as const, repoUrl: '', repoBranch: '', repoPull: true };

  it('sends the visibility with a plain topic, and no repo', () => {
    expect(createTopicBody(base)).toEqual({
      name: 'Handbook',
      slug: undefined,
      description: undefined,
      visibility: 'public',
      repo: undefined,
    });
  });

  it('sends Private and the repository binding together', () => {
    expect(
      createTopicBody({ ...base, slug: 'handbook', visibility: 'private', repoUrl: ' git@host:org/h.git ', repoBranch: 'main', repoPull: false }),
    ).toEqual({
      name: 'Handbook',
      slug: 'handbook',
      description: undefined,
      visibility: 'private',
      repo: { remote_url: 'git@host:org/h.git', branch: 'main', pull: false },
    });
  });
});
