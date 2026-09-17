/**
 * GitHub (and GitHub Enterprise) `ChangeRequestHost` over the REST API with an
 * instance-level token (plan §12: the service account opens the PR; the human
 * is the commit author and is named in the PR body).
 *
 * `ChangeRef.id` is `owner/repo#number` so later calls need only the ref.
 */
import type { ChangeRef, ChangeRequestHost, SourceRef } from '@echozedlabs/knowledge-types';
import { decodeChangeId, encodeChangeId, requestJson, type FetchImpl } from './http.js';

export interface GitHubHostOptions {
  token: string;
  /** REST base; default `https://api.github.com`. GitHub Enterprise: `https://ghe.example.com/api/v3`. */
  apiBase?: string;
  fetchImpl?: FetchImpl;
  /** Base branch when the source has none (default `main`). */
  defaultBranch?: string;
}

/** `git@github.com:o/r.git`, `ssh://git@github.com/o/r.git`, `https://github.com/o/r(.git)` → `{ owner, repo }`. */
export function parseRemote(url: string): { owner: string; repo: string } {
  const m =
    /^(?:ssh:\/\/)?(?:[\w.-]+@)?[\w.-]+(?::\d+)?[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url) ??
    /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) throw new Error(`not a GitHub remote: ${url}`);
  return { owner: m[1]!, repo: m[2]! };
}

interface PullResponse {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  merged: boolean;
}

export class GitHubHost implements ChangeRequestHost {
  readonly kind = 'github';
  private readonly token: string;
  private readonly apiBase: string;
  private readonly fetchImpl: FetchImpl;
  private readonly defaultBranch: string;

  constructor(opts: GitHubHostOptions) {
    this.token = opts.token;
    this.apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.defaultBranch = opts.defaultBranch ?? 'main';
  }

  async openChange(input: { source: SourceRef; branch: string; title: string; body: string }): Promise<ChangeRef> {
    if (!input.source.remote) throw new Error(`source ${input.source.id} has no remote`);
    const { owner, repo } = parseRemote(input.source.remote);
    const pr = await this.call<PullResponse>('POST', `/repos/${owner}/${repo}/pulls`, {
      title: input.title,
      head: input.branch,
      base: input.source.branch ?? this.defaultBranch,
      body: input.body,
    });
    return { host: this.kind, id: encodeChangeId(`${owner}/${repo}`, pr!.number), url: pr!.html_url };
  }

  async status(ref: ChangeRef): Promise<'open' | 'merged' | 'closed'> {
    const { repoKey, number } = decodeChangeId(ref.id);
    const pr = (await this.call<PullResponse>('GET', `/repos/${repoKey}/pulls/${number}`))!;
    if (pr.merged) return 'merged';
    return pr.state === 'closed' ? 'closed' : 'open';
  }

  async merge(ref: ChangeRef): Promise<void> {
    const { repoKey, number } = decodeChangeId(ref.id);
    await this.call('PUT', `/repos/${repoKey}/pulls/${number}/merge`, { merge_method: 'squash' });
  }

  async comment(ref: ChangeRef, body: string): Promise<void> {
    const { repoKey, number } = decodeChangeId(ref.id);
    await this.call('POST', `/repos/${repoKey}/issues/${number}/comments`, { body });
  }

  private call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T | null> {
    return requestJson<T>(this.fetchImpl, {
      method,
      url: `${this.apiBase}${path}`,
      token: this.token,
      body,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
  }
}
