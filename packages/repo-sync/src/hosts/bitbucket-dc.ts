/**
 * Bitbucket Data Center (self-hosted) `ChangeRequestHost` over REST 1.0 with
 * an HTTP access token (plan §12: Bitbucket Data Center, not Cloud).
 *
 * `ChangeRef.id` is `PROJECT/repo-slug#id` so later calls need only the ref.
 */
import type { ChangeRef, ChangeRequestHost, SourceRef } from '@echozedlabs/knowledge-types';
import { decodeChangeId, encodeChangeId, requestJson, type FetchImpl } from './http.js';

export interface BitbucketDcHostOptions {
  /** REST 1.0 root, e.g. `https://bitbucket.example/rest/api/1.0`. */
  baseUrl: string;
  token: string;
  fetchImpl?: FetchImpl;
  /** Target branch when the source has none (default `main`). */
  defaultBranch?: string;
}

/** `ssh://git@host:7999/PROJ/repo.git` or `https://host/scm/PROJ/repo.git` → `{ projectKey, repoSlug }`. */
export function parseRemote(url: string): { projectKey: string; repoSlug: string } {
  const m =
    /^ssh:\/\/(?:[\w.-]+@)?[\w.-]+(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url) ??
    /^https?:\/\/[^/]+(?:\/[^/]+)*?\/scm\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) throw new Error(`not a Bitbucket Data Center remote: ${url}`);
  return { projectKey: m[1]!, repoSlug: m[2]! };
}

interface PullRequestResponse {
  id: number;
  version: number;
  state: 'OPEN' | 'MERGED' | 'DECLINED';
  links?: { self?: { href: string }[] };
}

export class BitbucketDcHost implements ChangeRequestHost {
  readonly kind = 'bitbucket-dc';
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchImpl;
  private readonly defaultBranch: string;

  constructor(opts: BitbucketDcHostOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.defaultBranch = opts.defaultBranch ?? 'main';
  }

  async openChange(input: { source: SourceRef; branch: string; title: string; body: string }): Promise<ChangeRef> {
    if (!input.source.remote) throw new Error(`source ${input.source.id} has no remote`);
    const { projectKey, repoSlug } = parseRemote(input.source.remote);
    const repository = { slug: repoSlug, project: { key: projectKey } };
    const pr = (await this.call<PullRequestResponse>('POST', `${this.prPath(`${projectKey}/${repoSlug}`)}`, {
      title: input.title,
      description: input.body,
      fromRef: { id: `refs/heads/${input.branch}`, repository },
      toRef: { id: `refs/heads/${input.source.branch ?? this.defaultBranch}`, repository },
    }))!;
    return {
      host: this.kind,
      id: encodeChangeId(`${projectKey}/${repoSlug}`, pr.id),
      url: pr.links?.self?.[0]?.href ?? `${this.baseUrl}${this.prPath(`${projectKey}/${repoSlug}`)}/${pr.id}`,
    };
  }

  async status(ref: ChangeRef): Promise<'open' | 'merged' | 'closed'> {
    const pr = await this.get(ref);
    if (pr.state === 'MERGED') return 'merged';
    return pr.state === 'DECLINED' ? 'closed' : 'open';
  }

  async merge(ref: ChangeRef): Promise<void> {
    const pr = await this.get(ref);
    const { repoKey, number } = decodeChangeId(ref.id);
    await this.call('POST', `${this.prPath(repoKey)}/${number}/merge?version=${pr.version}`);
  }

  async comment(ref: ChangeRef, body: string): Promise<void> {
    const { repoKey, number } = decodeChangeId(ref.id);
    await this.call('POST', `${this.prPath(repoKey)}/${number}/comments`, { text: body });
  }

  private async get(ref: ChangeRef): Promise<PullRequestResponse> {
    const { repoKey, number } = decodeChangeId(ref.id);
    return (await this.call<PullRequestResponse>('GET', `${this.prPath(repoKey)}/${number}`))!;
  }

  /** `PROJ/repo` → `/projects/PROJ/repos/repo/pull-requests`. */
  private prPath(repoKey: string): string {
    const [projectKey, repoSlug] = repoKey.split('/');
    return `/projects/${projectKey}/repos/${repoSlug}/pull-requests`;
  }

  private call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T | null> {
    return requestJson<T>(this.fetchImpl, { method, url: `${this.baseUrl}${path}`, token: this.token, body });
  }
}
