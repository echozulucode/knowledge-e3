/**
 * `upstreamFileUrl` derives a browse link from the remote alone — no token, no
 * round trip — because the reader renders it for anonymous visitors. Every case
 * it cannot address must return null rather than a plausible-looking guess: a
 * wrong link into somebody else's repository is worse than no link.
 */
import { describe, expect, it } from 'vitest';
import { upstreamFileUrl } from '../src/index.js';

describe('upstreamFileUrl', () => {
  it('addresses a file on github.com from any remote spelling', () => {
    const expected = 'https://github.com/acme/handbook/blob/main/concepts/onboarding.md';
    for (const remote of [
      'https://github.com/acme/handbook.git',
      'https://github.com/acme/handbook',
      'git@github.com:acme/handbook.git',
      'ssh://git@github.com/acme/handbook.git',
    ]) {
      expect(upstreamFileUrl({ kind: 'github', remote, branch: 'main', path: 'concepts/onboarding.md' })).toBe(expected);
    }
  });

  it('keeps an enterprise GitHub host instead of rewriting it to github.com', () => {
    expect(
      upstreamFileUrl({
        kind: 'github',
        remote: 'https://git.acme.example/acme/handbook.git',
        branch: 'trunk',
        path: 'docs/guide.md',
      }),
    ).toBe('https://git.acme.example/acme/handbook/blob/trunk/docs/guide.md');
  });

  it('defaults to main when the source records no branch', () => {
    expect(upstreamFileUrl({ kind: 'github', remote: 'https://github.com/a/b', path: 'x.md' })).toBe(
      'https://github.com/a/b/blob/main/x.md',
    );
  });

  it('builds a Bitbucket Data Center browse URL from the REST base URL', () => {
    expect(
      upstreamFileUrl({
        kind: 'bitbucket-dc',
        remote: 'https://bitbucket.example/scm/PLAT/handbook.git',
        baseUrl: 'https://bitbucket.example/rest/api/1.0',
        branch: 'main',
        path: 'concepts/onboarding.md',
      }),
    ).toBe('https://bitbucket.example/projects/PLAT/repos/handbook/browse/concepts/onboarding.md?at=refs%2Fheads%2Fmain');
  });

  it('falls back to the remote origin for Bitbucket when no REST base URL is configured', () => {
    expect(
      upstreamFileUrl({
        kind: 'bitbucket-dc',
        remote: 'https://bitbucket.example/scm/PLAT/handbook.git',
        branch: 'main',
        path: 'a.md',
      }),
    ).toBe('https://bitbucket.example/projects/PLAT/repos/handbook/browse/a.md?at=refs%2Fheads%2Fmain');
  });

  it('returns null — never a guess — when the link cannot be derived', () => {
    const path = 'concepts/a.md';
    // An ssh Bitbucket remote carries no web origin, and nothing else says what it is.
    expect(upstreamFileUrl({ kind: 'bitbucket-dc', remote: 'ssh://git@bitbucket.example:7999/PLAT/handbook.git', path })).toBeNull();
    expect(upstreamFileUrl({ kind: null, remote: 'https://github.com/a/b', path })).toBeNull();
    expect(upstreamFileUrl({ kind: 'github', remote: null, path })).toBeNull();
    expect(upstreamFileUrl({ kind: 'github', remote: 'https://example.com/not-a-repo-url', path })).toBeNull();
    expect(upstreamFileUrl({ kind: 'github', remote: 'https://github.com/a/b', path: '' })).toBeNull();
  });

  it('escapes path segments without escaping the separators', () => {
    expect(upstreamFileUrl({ kind: 'github', remote: 'https://github.com/a/b', branch: 'main', path: 'my notes/a b.md' })).toBe(
      'https://github.com/a/b/blob/main/my%20notes/a%20b.md',
    );
  });
});
