import { BitbucketDcHost, parseRemote as parseBitbucketDcRemote, type BitbucketDcHostOptions } from './bitbucket-dc.js';
import { GitHubHost, parseRemote as parseGitHubRemote, type GitHubHostOptions } from './github.js';

export type HostKind = 'github' | 'bitbucket-dc';

export function createHost(kind: 'github', opts: GitHubHostOptions): GitHubHost;
export function createHost(kind: 'bitbucket-dc', opts: BitbucketDcHostOptions): BitbucketDcHost;
export function createHost(kind: HostKind, opts: GitHubHostOptions | BitbucketDcHostOptions): GitHubHost | BitbucketDcHost;
export function createHost(kind: HostKind, opts: GitHubHostOptions | BitbucketDcHostOptions): GitHubHost | BitbucketDcHost {
  switch (kind) {
    case 'github':
      return new GitHubHost(opts as GitHubHostOptions);
    case 'bitbucket-dc':
      return new BitbucketDcHost(opts as BitbucketDcHostOptions);
    default:
      throw new Error(`unknown change-request host: ${String(kind)}`);
  }
}

/**
 * Where a file lives on the host's web UI, for a "view / suggest a change"
 * link out of the reader (plan §8.3, "reference another team's bundle").
 *
 * Derived from the remote URL rather than from an API call: the reader must
 * render the link without a token and without a round trip, and a browse URL
 * is the one thing both hosts shape predictably. Returns `null` — never a
 * guess — when there is no remote, no host kind, or the remote is not one this
 * adapter can parse; the caller then renders no link at all.
 */
export function upstreamFileUrl(input: {
  kind: HostKind | null | undefined;
  remote: string | null | undefined;
  path: string;
  branch?: string | null;
  /** REST root of a self-hosted instance; its web root is derived from it. */
  baseUrl?: string | null;
}): string | null {
  const { kind, remote, path } = input;
  if (!kind || !remote || !path) return null;
  const branch = input.branch ?? 'main';
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  try {
    if (kind === 'github') {
      const { owner, repo } = parseGitHubRemote(remote);
      const web = webHostOf(remote) ?? 'https://github.com';
      return `${web}/${owner}/${repo}/blob/${encodeURIComponent(branch)}/${encoded}`;
    }
    if (kind === 'bitbucket-dc') {
      const { projectKey, repoSlug } = parseBitbucketDcRemote(remote);
      const web = bitbucketWebRoot(input.baseUrl) ?? webHostOf(remote);
      if (!web) return null;
      return `${web}/projects/${projectKey}/repos/${repoSlug}/browse/${encoded}?at=${encodeURIComponent(`refs/heads/${branch}`)}`;
    }
  } catch {
    // An unparseable remote is not an error here: the link is an affordance.
    return null;
  }
  return null;
}

/** `https://host/...` → `https://host`; an ssh/scp remote has no web origin we can assume. */
function webHostOf(remote: string): string | null {
  const m = /^(https?:\/\/)(?:[^@/]+@)?([^/]+)/.exec(remote);
  return m ? `${m[1]}${m[2]}` : null;
}

/** `https://bitbucket.example/rest/api/1.0` → `https://bitbucket.example`. */
function bitbucketWebRoot(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  const m = /^(https?:\/\/[^/]+)/.exec(baseUrl);
  return m ? m[1]! : null;
}
