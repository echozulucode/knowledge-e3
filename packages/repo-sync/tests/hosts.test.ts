import { describe, expect, it } from 'vitest';
import type { SourceRef } from '@echozedlabs/knowledge-types';
import {
  BitbucketDcHost,
  GitHubHost,
  HostError,
  createHost,
  decodeChangeId,
  encodeChangeId,
  parseBitbucketDcRemote,
  parseGitHubRemote,
  type FetchImpl,
} from '../src/index.js';

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(responses: { status?: number; body?: unknown }[]): { fetchImpl: FetchImpl; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift() ?? { status: 200, body: {} };
    const text = next.body === undefined ? '' : JSON.stringify(next.body);
    return new Response(text, { status: next.status ?? 200 });
  };
  return { fetchImpl, calls };
}

const source = (remote: string, branch: string | null = 'main'): SourceRef => ({
  id: 'src',
  local: '/tmp/x',
  remote,
  branch,
  role: 'authoritative',
  policy: { mode: 'review' },
});

describe('change ids', () => {
  it('round-trip the repository key and number', () => {
    expect(encodeChangeId('o/r', 12)).toBe('o/r#12');
    expect(decodeChangeId('PROJ/repo#7')).toEqual({ repoKey: 'PROJ/repo', number: '7' });
    expect(() => decodeChangeId('12')).toThrow(/malformed/);
  });
});

describe('GitHubHost', () => {
  it('parses ssh and https remotes', () => {
    expect(parseGitHubRemote('git@github.com:acme/kb.git')).toEqual({ owner: 'acme', repo: 'kb' });
    expect(parseGitHubRemote('ssh://git@github.com/acme/kb.git')).toEqual({ owner: 'acme', repo: 'kb' });
    expect(parseGitHubRemote('https://github.com/acme/kb.git')).toEqual({ owner: 'acme', repo: 'kb' });
    expect(parseGitHubRemote('https://github.com/acme/kb')).toEqual({ owner: 'acme', repo: 'kb' });
    expect(parseGitHubRemote('https://ghe.example.com/acme/kb.git')).toEqual({ owner: 'acme', repo: 'kb' });
    expect(() => parseGitHubRemote('not a url')).toThrow(/not a GitHub remote/);
  });

  it('opens a pull request with the right URL, method, headers and body', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 201, body: { number: 12, html_url: 'https://github.com/acme/kb/pull/12', state: 'open', merged: false } }]);
    const host = new GitHubHost({ token: 'tok', fetchImpl });
    const ref = await host.openChange({ source: source('git@github.com:acme/kb.git'), branch: 'e3/post-abc', title: 'Post', body: 'By Alice' });
    expect(ref).toEqual({ host: 'github', id: 'acme/kb#12', url: 'https://github.com/acme/kb/pull/12' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/kb/pulls',
      method: 'POST',
      body: { title: 'Post', head: 'e3/post-abc', base: 'main', body: 'By Alice' },
    });
    expect(calls[0]!.headers).toMatchObject({
      Authorization: 'Bearer tok',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    });
  });

  it('uses apiBase for GitHub Enterprise and the default branch when the source has none', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 201, body: { number: 1, html_url: 'u' } }]);
    const host = new GitHubHost({ token: 't', apiBase: 'https://ghe.example.com/api/v3/', fetchImpl, defaultBranch: 'trunk' });
    await host.openChange({ source: source('https://ghe.example.com/acme/kb.git', null), branch: 'b', title: 't', body: '' });
    expect(calls[0]!.url).toBe('https://ghe.example.com/api/v3/repos/acme/kb/pulls');
    expect(calls[0]!.body).toMatchObject({ base: 'trunk' });
  });

  it('maps pull state to open / merged / closed', async () => {
    const { fetchImpl, calls } = mockFetch([
      { body: { state: 'open', merged: false } },
      { body: { state: 'closed', merged: true } },
      { body: { state: 'closed', merged: false } },
    ]);
    const host = new GitHubHost({ token: 't', fetchImpl });
    const ref = { host: 'github', id: 'acme/kb#12', url: '' };
    expect(await host.status(ref)).toBe('open');
    expect(await host.status(ref)).toBe('merged');
    expect(await host.status(ref)).toBe('closed');
    expect(calls.every((c) => c.url === 'https://api.github.com/repos/acme/kb/pulls/12' && c.method === 'GET')).toBe(true);
  });

  it('merges with squash and comments through the issues API', async () => {
    const { fetchImpl, calls } = mockFetch([{ body: { merged: true } }, { status: 201, body: { id: 1 } }]);
    const host = new GitHubHost({ token: 't', fetchImpl });
    const ref = { host: 'github', id: 'acme/kb#12', url: '' };
    await host.merge(ref);
    await host.comment(ref, 'Lint: 2 warnings');
    expect(calls[0]).toMatchObject({ url: 'https://api.github.com/repos/acme/kb/pulls/12/merge', method: 'PUT', body: { merge_method: 'squash' } });
    expect(calls[1]).toMatchObject({ url: 'https://api.github.com/repos/acme/kb/issues/12/comments', method: 'POST', body: { body: 'Lint: 2 warnings' } });
  });

  it('throws HostError with status and body on non-2xx', async () => {
    const { fetchImpl } = mockFetch([{ status: 422, body: { message: 'Validation Failed' } }]);
    const host = new GitHubHost({ token: 't', fetchImpl });
    const err = await host.status({ host: 'github', id: 'acme/kb#12', url: '' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostError);
    expect(err as HostError).toMatchObject({ status: 422, body: '{"message":"Validation Failed"}', method: 'GET' });
  });
});

describe('BitbucketDcHost', () => {
  const baseUrl = 'https://bitbucket.example/rest/api/1.0';
  const prs = `${baseUrl}/projects/PROJ/repos/kb/pull-requests`;

  it('parses ssh and https (scm) remotes', () => {
    expect(parseBitbucketDcRemote('ssh://git@bitbucket.example:7999/PROJ/kb.git')).toEqual({ projectKey: 'PROJ', repoSlug: 'kb' });
    expect(parseBitbucketDcRemote('ssh://git@bitbucket.example/~jdoe/kb.git')).toEqual({ projectKey: '~jdoe', repoSlug: 'kb' });
    expect(parseBitbucketDcRemote('https://bitbucket.example/scm/PROJ/kb.git')).toEqual({ projectKey: 'PROJ', repoSlug: 'kb' });
    expect(parseBitbucketDcRemote('https://jdoe@bitbucket.example/bitbucket/scm/PROJ/kb.git')).toEqual({ projectKey: 'PROJ', repoSlug: 'kb' });
    expect(() => parseBitbucketDcRemote('https://github.com/acme/kb.git')).toThrow(/not a Bitbucket/);
  });

  it('opens a pull request with fromRef/toRef and encodes the repository in the id', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 201, body: { id: 7, version: 0, state: 'OPEN', links: { self: [{ href: 'https://bitbucket.example/projects/PROJ/repos/kb/pull-requests/7' }] } } }]);
    const host = new BitbucketDcHost({ baseUrl: `${baseUrl}/`, token: 'tok', fetchImpl });
    const ref = await host.openChange({ source: source('ssh://git@bitbucket.example:7999/PROJ/kb.git'), branch: 'e3/post-abc', title: 'Post', body: 'By Alice' });
    expect(ref).toEqual({ host: 'bitbucket-dc', id: 'PROJ/kb#7', url: 'https://bitbucket.example/projects/PROJ/repos/kb/pull-requests/7' });
    const repository = { slug: 'kb', project: { key: 'PROJ' } };
    expect(calls[0]).toMatchObject({
      url: prs,
      method: 'POST',
      body: {
        title: 'Post',
        description: 'By Alice',
        fromRef: { id: 'refs/heads/e3/post-abc', repository },
        toRef: { id: 'refs/heads/main', repository },
      },
    });
    expect(calls[0]!.headers).toMatchObject({ Authorization: 'Bearer tok', Accept: 'application/json', 'Content-Type': 'application/json' });
  });

  it('maps OPEN / MERGED / DECLINED', async () => {
    const { fetchImpl, calls } = mockFetch([{ body: { state: 'OPEN' } }, { body: { state: 'MERGED' } }, { body: { state: 'DECLINED' } }]);
    const host = new BitbucketDcHost({ baseUrl, token: 't', fetchImpl });
    const ref = { host: 'bitbucket-dc', id: 'PROJ/kb#7', url: '' };
    expect(await host.status(ref)).toBe('open');
    expect(await host.status(ref)).toBe('merged');
    expect(await host.status(ref)).toBe('closed');
    expect(calls.every((c) => c.url === `${prs}/7` && c.method === 'GET')).toBe(true);
  });

  it('merges with the current version and posts comments as text', async () => {
    const { fetchImpl, calls } = mockFetch([{ body: { id: 7, version: 3, state: 'OPEN' } }, { body: { state: 'MERGED' } }, { status: 201, body: { id: 99 } }]);
    const host = new BitbucketDcHost({ baseUrl, token: 't', fetchImpl });
    const ref = { host: 'bitbucket-dc', id: 'PROJ/kb#7', url: '' };
    await host.merge(ref);
    await host.comment(ref, 'Lint: 1 error');
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', `${prs}/7`],
      ['POST', `${prs}/7/merge?version=3`],
      ['POST', `${prs}/7/comments`],
    ]);
    expect(calls[1]!.body).toBeUndefined();
    expect(calls[2]!.body).toEqual({ text: 'Lint: 1 error' });
  });

  it('throws HostError on non-2xx', async () => {
    const { fetchImpl } = mockFetch([{ status: 409, body: { errors: [{ message: 'conflicted' }] } }]);
    const host = new BitbucketDcHost({ baseUrl, token: 't', fetchImpl });
    await expect(host.merge({ host: 'bitbucket-dc', id: 'PROJ/kb#7', url: '' })).rejects.toMatchObject({ name: 'HostError', status: 409 });
  });
});

describe('createHost', () => {
  it('builds the adapter for each kind and rejects unknown kinds', () => {
    expect(createHost('github', { token: 't' })).toBeInstanceOf(GitHubHost);
    expect(createHost('bitbucket-dc', { baseUrl: 'https://b/rest/api/1.0', token: 't' })).toBeInstanceOf(BitbucketDcHost);
    expect(() => createHost('gitlab' as never, { token: 't' })).toThrow(/unknown change-request host/);
  });
});
