/**
 * Per-call git transport credentials (issue 122).
 *
 * One source, one credential: a source names an environment variable
 * (`host_token_env`) and every `git` call made for THAT source authenticates
 * with the token that variable holds — clone, fetch, push, `ls-remote`. The
 * instance-wide `GIT_HTTPS_TOKEN` stays as the fallback for a single-host
 * install, so nothing that works today stops working.
 *
 * **How the token reaches git, and why it cannot leak.** The token is handed to
 * the git child process through its own environment and nowhere else:
 *
 *  - `GIT_ASKPASS` points at a tiny shell script that `echo`s two environment
 *    variables. The script holds no secret — the secret is in the environment of
 *    the git process that runs it, so it exists only for the lifetime of that
 *    one call and only for that one source.
 *  - Nothing goes in argv: `git -c …` is visible in `ps` to every user on the
 *    box, so the only `-c` we add is `credential.helper=` (a name, not a value).
 *  - Nothing goes in the remote URL, so it cannot reach `.git/config`, a
 *    reflog, a fetch's progress output, or an error message.
 *  - Nothing goes in gitconfig, so it is never written to disk.
 *  - `runGit` scrubs the token out of anything git printed before it becomes a
 *    `GitError` message, so a failing authenticated fetch cannot record it in
 *    `content_sources.last_error` (belt and braces — git has no reason to print
 *    a password it was given over askpass, but the recorded error is durable).
 *
 * **Why `credential.helper=` is reset.** Git asks configured credential helpers
 * *before* it asks askpass. An ambient helper (macOS keychain, Git Credential
 * Manager on a Windows dev box, a `store` file in the container) caches by HOST,
 * not by source — so two sources on github.com with different tokens would both
 * get whichever one the helper cached first. Clearing the helper list for calls
 * that carry a credential makes the per-source token the only answer git can
 * get. The empty value is git's documented way to reset the list.
 *
 * **Why `GIT_TERMINAL_PROMPT=0`.** Without it, a missing or wrong credential
 * makes git block forever on "Username for …" and the sync cycle for that source
 * never returns. `runGit` sets it on every call, not just authenticated ones.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The instance-wide fallback token, used when a source names no variable of its own. */
export const GLOBAL_GIT_TOKEN_ENV = 'GIT_HTTPS_TOKEN';

/** Env var the askpass script reads the username from (set per git call). */
export const ASKPASS_USERNAME_ENV = 'E3_GIT_USERNAME';
/** Env var the askpass script reads the token from (set per git call). */
export const ASKPASS_PASSWORD_ENV = 'E3_GIT_PASSWORD';

/**
 * Username git sends with the token, by host kind. HTTPS basic auth needs both
 * halves and every host has its own convention for the half that is not the
 * token. Override per source by setting `<TOKEN_ENV>_USERNAME` — a Bitbucket
 * Data Center instance configured for personal access tokens wants the real
 * account name there.
 */
const USERNAME_BY_HOST_KIND: Record<string, string> = {
  // A GitHub PAT (classic or fine-grained) and an App installation token both
  // authenticate as the literal user `x-access-token`.
  github: 'x-access-token',
  // Bitbucket's token convention. DC also accepts <account>:<http access token>,
  // which is what `<TOKEN_ENV>_USERNAME` is for.
  'bitbucket-dc': 'x-token-auth',
};

/** Fallback when the source names no host kind (an unknown or self-hosted host). */
export const DEFAULT_ASKPASS_USERNAME = 'x-access-token';

/** What a source tells us about its credential — names and the remote, never a value. */
export interface GitCredentialRef {
  /** `content_sources.host_token_env`: the NAME of the variable holding the token. */
  tokenEnv?: string | null;
  /** `content_sources.host_kind`: picks the username convention. */
  hostKind?: string | null;
  /** The source's remote URL; only an `http(s)` remote can use a token. */
  remote?: string | null;
}

/** A credential resolved for one git call. Nothing here that is safe to log carries the token. */
export interface ResolvedGitCredential {
  /** The variable the token came from — safe to log, and the useful half for an operator. */
  tokenEnvName: string;
  /** Extra environment for the git child (holds the token; never logged). */
  env: Record<string, string>;
  /** Extra `git -c …` arguments. Never contains a secret — see the module note. */
  args: string[];
  /** Values `runGit` must scrub from anything it reports. */
  secrets: string[];
}

/**
 * Is this remote one a token can authenticate? Only `http(s)`: an `ssh://` or
 * `file://` remote uses a key or the filesystem, and attaching a token there
 * would be pointless and would widen where the secret travels.
 */
export function isTokenAuthRemote(remote: string | null | undefined): boolean {
  return /^https?:\/\//i.test((remote ?? '').trim());
}

/**
 * Which variable actually supplies this source's token: the source's own if it
 * names one AND that variable is set, else the instance-wide fallback if that
 * is set, else none. The source's own always wins — an operator who named a
 * variable for this source meant that identity, not the shared one.
 *
 * A blank/whitespace-only value counts as not set, the same definition
 * `envVarPresent` uses on the server: `"   "` is an unsubstituted `FOO=${FOO}`
 * in a Compose file, not a token.
 */
export function resolveTokenEnvName(
  ref: GitCredentialRef,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const own = ref.tokenEnv?.trim();
  if (own && (env[own] ?? '').trim() !== '') return own;
  if ((env[GLOBAL_GIT_TOKEN_ENV] ?? '').trim() !== '') return GLOBAL_GIT_TOKEN_ENV;
  return null;
}

/** The username git pairs with the token: the `<TOKEN_ENV>_USERNAME` override, else the host convention. */
export function askpassUsername(
  tokenEnvName: string,
  hostKind: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = (env[`${tokenEnvName}_USERNAME`] ?? '').trim();
  if (override) return override;
  return USERNAME_BY_HOST_KIND[(hostKind ?? '').trim()] ?? DEFAULT_ASKPASS_USERNAME;
}

/**
 * Resolve the credential for one source's git call, or `null` when there is
 * none to use (no token named and no global fallback, or a remote no token
 * applies to).
 *
 * Resolution happens HERE, at the call, from the name the registry stored —
 * never at start-up into a long-lived object. An admin can change the variable
 * or the operator can restart with a new value and the next cycle picks it up,
 * and no part of the process holds the token between calls.
 */
export function resolveGitCredential(
  ref: GitCredentialRef,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedGitCredential | null {
  if (ref.remote !== undefined && !isTokenAuthRemote(ref.remote)) return null;
  const tokenEnvName = resolveTokenEnvName(ref, env);
  if (!tokenEnvName) return null;
  const token = (env[tokenEnvName] ?? '').trim();
  if (!token) return null;
  return {
    tokenEnvName,
    env: {
      GIT_ASKPASS: askpassScriptPath(),
      [ASKPASS_USERNAME_ENV]: askpassUsername(tokenEnvName, ref.hostKind, env),
      [ASKPASS_PASSWORD_ENV]: token,
    },
    // Reset the helper list so only our askpass answers — see the module note.
    args: ['-c', 'credential.helper='],
    secrets: [token],
  };
}

// ------------------------------------------------------------ askpass script

let scriptPath: string | null = null;

/**
 * The askpass helper, written once per process into a private temp directory
 * (owner-only) and removed on exit.
 *
 * WHY generated rather than shipped in the package: the file has to be
 * *executable by git*, and the two deployment targets disagree about what that
 * means. Generating it means one code path sets the mode bits on Linux (a
 * package file copied by a Docker `COPY` or an npm install has whatever mode
 * the build left it), and no build step has to remember to carry a non-`.ts`
 * file into `dist/` — a missing file there would break authentication only in
 * production, which is exactly where it must not break.
 *
 * WHY a `/bin/sh` script rather than a Node one: git runs the askpass program
 * itself, so it must be directly executable with no interpreter argument. On
 * Linux that is the shebang. On Windows — where this project's tests run — Git
 * for Windows reads the shebang too and runs the file through its bundled
 * `sh.exe`, provided the path it is given has no shell metacharacters, which is
 * why the path is handed over with forward slashes. Verified on both.
 *
 * The script contains NO secret: it echoes two environment variables, and those
 * are set only on the git process that is allowed to see them. That is what
 * makes one shared script safe — the scoping is the child's environment, not the
 * file.
 */
export function askpassScriptPath(): string {
  if (scriptPath) return scriptPath;
  const dir = mkdtempSync(join(tmpdir(), 'e3-git-askpass-'));
  const file = join(dir, 'askpass.sh');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      '# Knowledge E3 git askpass helper. Holds no secret: it answers with the',
      '# environment git was started with. Safe to delete; it is regenerated.',
      'case "$1" in',
      `  *[Uu]sername*) printf '%s\\n' "$${ASKPASS_USERNAME_ENV}" ;;`,
      `  *) printf '%s\\n' "$${ASKPASS_PASSWORD_ENV}" ;;`,
      'esac',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  // Forward slashes: see the WHY above — a backslash is a shell metacharacter
  // to Git for Windows and would send the path through a quoting path that eats it.
  scriptPath = file.replace(/\\/g, '/');
  const clean = (): void => {
    scriptPath = null;
    rmSync(dir, { recursive: true, force: true });
  };
  process.once('exit', clean);
  return scriptPath;
}

/** Test seam: forget (and delete) the generated script so the next call regenerates it. */
export function resetAskpassScript(): void {
  if (!scriptPath) return;
  rmSync(join(scriptPath, '..'), { recursive: true, force: true });
  scriptPath = null;
}

/**
 * Replace every occurrence of `secrets` in `text` with `***`.
 *
 * Applied to anything that becomes a `GitError` message, because those messages
 * are durable: they land in `content_sources.last_error`, in the Sources table,
 * and in the log.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue; // too short to redact without mangling output
    out = out.split(secret).join('***');
  }
  return out;
}
