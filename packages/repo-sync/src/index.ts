/**
 * @echozedlabs/repo-sync — `GitRepo` over a working directory, the `SyncEngine`
 * state machine, review-flow helpers, and `ChangeRequestHost` adapters.
 * See the knowledge hub plan §8, §9.2–9.3 and §12.
 */
export { runGit, GitError, DEFAULT_GIT_TIMEOUT_MS, type GitExecOptions } from './git.js';
export {
  LocalGitRepo,
  SYSTEM_COMMITTER,
  EMPTY_TREE,
  type GitIdentity,
  type LocalGitRepoOptions,
  type CommitOptions,
  type ConflictSides,
} from './git-repo.js';
export {
  SyncEngine,
  DEFAULT_PUSH_INTERVAL_MS,
  type SyncRepo,
  type SyncHooks,
  type SyncLogLevel,
  type SyncEngineOptions,
  type PushReason,
  type ConflictChoice,
} from './sync-engine.js';
export { ReviewFlow, itemBranchName, DEFAULT_BRANCH_PREFIX, type ReviewRepo, type OpenForItemInput } from './review.js';
export { HostError, encodeChangeId, decodeChangeId, type FetchImpl } from './hosts/http.js';
export { GitHubHost, parseRemote as parseGitHubRemote, type GitHubHostOptions } from './hosts/github.js';
export {
  BitbucketDcHost,
  parseRemote as parseBitbucketDcRemote,
  type BitbucketDcHostOptions,
} from './hosts/bitbucket-dc.js';
export { createHost, upstreamFileUrl, type HostKind } from './hosts/index.js';
