/**
 * Per-source git transport credentials (issue 122).
 *
 * The question these tests have to answer is not "does GitHub accept the
 * token" — it is "does the token git was handed come from THIS source, and can
 * it be observed anywhere else". Both are answered without a network:
 *
 *  - `git credential fill` is git's own credential machinery. Given a protocol
 *    and host on stdin it consults the configured helpers, then falls back to
 *    prompting through `GIT_ASKPASS` — and prints exactly what it resolved. So
 *    it reports, byte for byte, the username and password a `fetch` to that
 *    host would have used, with no remote to reach.
 *  - The end-to-end transport path (a real clone/fetch/push against a local
 *    origin) is exercised by `git-repo.test.ts`; the case added here is that a
 *    repo configured WITH a credential still does all of it.
 *
 *  - One case goes all the way through the transport: a local HTTP listener
 *    that demands basic auth, so the `Authorization` header git actually put on
 *    the wire is the assertion. No TLS and no `git http-backend` — the header is
 *    the whole question, and a real repository behind it would add nothing.
 *
 * Not covered: a live github.com / Bitbucket Data Center repository. Nothing
 * here proves those hosts accept the username convention, only that the
 * convention is what git sends.
 */
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GLOBAL_GIT_TOKEN_ENV,
  GitError,
  LocalGitRepo,
  askpassScriptPath,
  askpassUsername,
  isTokenAuthRemote,
  redactSecrets,
  resolveGitCredential,
  resolveTokenEnvName,
} from '../src/index.js';
import { ALICE, ensureGitEnv, makeFixture, write, type Fixture } from './helpers.js';

const REMOTE = 'https://github.com/acme/private.git';
const BITBUCKET_REMOTE = 'https://bitbucket.example.com/scm/team/docs.git';

/** Every env var these tests set, cleared between them so none leaks into the next. */
const TOUCHED = [
  'SOURCE_A_TOKEN',
  'SOURCE_A_TOKEN_USERNAME',
  'SOURCE_B_TOKEN',
  'BITBUCKET_TOKEN',
  'BITBUCKET_TOKEN_USERNAME',
  GLOBAL_GIT_TOKEN_ENV,
];

beforeEach(() => {
  ensureGitEnv();
  for (const k of TOUCHED) delete process.env[k];
});
afterEach(() => {
  for (const k of TOUCHED) delete process.env[k];
});

/**
 * What git would send to `host` for a source with this credential: the answer
 * `git credential fill` resolves, plus the argv the call was actually made with.
 *
 * `credential.helper=` comes from the resolved credential, not from the test —
 * that reset is part of what is under test, because an ambient helper (a
 * keychain, Git Credential Manager, a `store` file) caches by host and would
 * otherwise answer for every source alike.
 */
async function fillCredential(
  ref: Parameters<typeof resolveGitCredential>[0],
  host: string,
): Promise<{ username?: string; password?: string; argv: string[]; stderr: string }> {
  const cred = resolveGitCredential(ref);
  const argv = [...(cred?.args ?? []), 'credential', 'fill'];
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      argv,
      {
        timeout: 15_000,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(cred?.env ?? {}) },
      },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          resolve({ argv, stderr: String(stderr) });
          return;
        }
        if (err) {
          reject(err);
          return;
        }
        const fields = Object.fromEntries(
          String(stdout)
            .split('\n')
            .filter(Boolean)
            .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
        );
        resolve({ username: fields['username'], password: fields['password'], argv, stderr: String(stderr) });
      },
    );
    child.stdin!.end(`protocol=https\nhost=${host}\n\n`);
  });
}

describe('resolution', () => {
  it("prefers the source's own variable over the instance-wide one", () => {
    process.env['SOURCE_A_TOKEN'] = 'own';
    process.env[GLOBAL_GIT_TOKEN_ENV] = 'global';
    expect(resolveTokenEnvName({ tokenEnv: 'SOURCE_A_TOKEN' })).toBe('SOURCE_A_TOKEN');
  });

  it('falls back to GIT_HTTPS_TOKEN when the source names none, or names one that is not set', () => {
    process.env[GLOBAL_GIT_TOKEN_ENV] = 'global';
    expect(resolveTokenEnvName({})).toBe(GLOBAL_GIT_TOKEN_ENV);
    expect(resolveTokenEnvName({ tokenEnv: 'SOURCE_A_TOKEN' })).toBe(GLOBAL_GIT_TOKEN_ENV);
  });

  it('resolves to nothing when neither is set, and treats a blank value as not set', () => {
    expect(resolveTokenEnvName({ tokenEnv: 'SOURCE_A_TOKEN' })).toBeNull();
    // An unsubstituted `FOO=${FOO}` in a Compose file, not a token.
    process.env['SOURCE_A_TOKEN'] = '   ';
    expect(resolveTokenEnvName({ tokenEnv: 'SOURCE_A_TOKEN' })).toBeNull();
    expect(resolveGitCredential({ tokenEnv: 'SOURCE_A_TOKEN', remote: REMOTE })).toBeNull();
  });

  it('only applies a token to an http(s) remote', () => {
    process.env['SOURCE_A_TOKEN'] = 'own';
    expect(isTokenAuthRemote('https://github.com/a/b.git')).toBe(true);
    expect(isTokenAuthRemote('git@github.com:a/b.git')).toBe(false);
    expect(resolveGitCredential({ tokenEnv: 'SOURCE_A_TOKEN', remote: 'git@github.com:a/b.git' })).toBeNull();
    expect(resolveGitCredential({ tokenEnv: 'SOURCE_A_TOKEN', remote: '/srv/repos/b.git' })).toBeNull();
  });

  it('picks the username by host kind, and lets <VAR>_USERNAME override it', () => {
    expect(askpassUsername('SOURCE_A_TOKEN', 'github')).toBe('x-access-token');
    expect(askpassUsername('BITBUCKET_TOKEN', 'bitbucket-dc')).toBe('x-token-auth');
    expect(askpassUsername('SOURCE_A_TOKEN', null)).toBe('x-access-token');
    process.env['BITBUCKET_TOKEN_USERNAME'] = 'e3.service';
    expect(askpassUsername('BITBUCKET_TOKEN', 'bitbucket-dc')).toBe('e3.service');
  });
});

describe('what git is actually given', () => {
  it('two sources naming different variables each authenticate with their own token', async () => {
    process.env['SOURCE_A_TOKEN'] = 'token-for-a';
    process.env['SOURCE_B_TOKEN'] = 'token-for-b';

    const a = await fillCredential({ tokenEnv: 'SOURCE_A_TOKEN', hostKind: 'github', remote: REMOTE }, 'github.com');
    const b = await fillCredential({ tokenEnv: 'SOURCE_B_TOKEN', hostKind: 'github', remote: REMOTE }, 'github.com');

    expect(a.password).toBe('token-for-a');
    expect(b.password).toBe('token-for-b');
    // Same host, same process, one after the other: neither saw the other's.
    expect(a.password).not.toBe(b.password);
    expect(a.username).toBe('x-access-token');
  });

  it('a source with no token of its own falls back to GIT_HTTPS_TOKEN', async () => {
    process.env[GLOBAL_GIT_TOKEN_ENV] = 'the-global-one';
    const filled = await fillCredential({ hostKind: 'github', remote: REMOTE }, 'github.com');
    expect(filled.password).toBe('the-global-one');
  });

  it('with no credential at all it fails fast instead of waiting on a prompt', async () => {
    const filled = await fillCredential({ tokenEnv: 'SOURCE_A_TOKEN', remote: REMOTE }, 'github.com');
    expect(filled.username).toBeUndefined();
    expect(filled.stderr).toMatch(/terminal prompts disabled/);
  });

  it("a non-GitHub host gets its credential too, with that host's username convention", async () => {
    process.env['BITBUCKET_TOKEN'] = 'bb-token';
    const filled = await fillCredential(
      { tokenEnv: 'BITBUCKET_TOKEN', hostKind: 'bitbucket-dc', remote: BITBUCKET_REMOTE },
      'bitbucket.example.com',
    );
    expect(filled.username).toBe('x-token-auth');
    expect(filled.password).toBe('bb-token');
  });

  it('honours <VAR>_USERNAME for a host that wants a real account name', async () => {
    process.env['BITBUCKET_TOKEN'] = 'bb-token';
    process.env['BITBUCKET_TOKEN_USERNAME'] = 'e3.service';
    const filled = await fillCredential(
      { tokenEnv: 'BITBUCKET_TOKEN', hostKind: 'bitbucket-dc', remote: BITBUCKET_REMOTE },
      'bitbucket.example.com',
    );
    expect(filled.username).toBe('e3.service');
  });
});

describe('over the wire', () => {
  let server: Server;
  let seen: { url: string; auth: string | undefined }[];
  let base: string;

  beforeEach(async () => {
    seen = [];
    server = createServer((req: IncomingMessage, res) => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization });
      if (!req.headers.authorization) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="knowledge-e3"' });
        res.end();
        return;
      }
      // Credentials accepted and recorded; there is no repository behind this,
      // so the fetch fails afterwards — which is fine, the header is the point.
      res.writeHead(403);
      res.end('no repository here');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((done) => server.close(done));
  });

  /** The `user:password` pair git put in the Authorization header of the last authenticated request. */
  function sentCredential(): string {
    const authed = seen.filter((r) => r.auth);
    const header = authed[authed.length - 1]?.auth ?? '';
    return Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
  }

  async function fetchWith(dir: string, tokenEnv: string, hostKind: string, path: string): Promise<void> {
    const remote = `${base}${path}`;
    const repo = new LocalGitRepo(dir, { credential: { tokenEnv, hostKind, remote } });
    await repo.init({ initialBranch: 'main' });
    await repo.setRemote(remote);
    await repo.fetch().catch(() => undefined); // 403 — expected, see the listener
  }

  it('sends each source its own token, and the username its host kind calls for', async () => {
    process.env['SOURCE_A_TOKEN'] = 'token-for-a';
    process.env['BITBUCKET_TOKEN'] = 'bb-token';
    const dir = mkdtempSync(join(tmpdir(), 'repo-sync-http-'));
    try {
      await fetchWith(join(dir, 'a'), 'SOURCE_A_TOKEN', 'github', '/acme/a.git');
      expect(sentCredential()).toBe('x-access-token:token-for-a');

      seen = [];
      await fetchWith(join(dir, 'b'), 'BITBUCKET_TOKEN', 'bitbucket-dc', '/scm/team/docs.git');
      expect(sentCredential()).toBe('x-token-auth:bb-token');
      // The second source never sent the first's token, on the same host.
      expect(seen.map((r) => r.auth ?? '').join('\n')).not.toContain(
        Buffer.from('x-access-token:token-for-a').toString('base64'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('a source with no token of its own authenticates with GIT_HTTPS_TOKEN', async () => {
    process.env[GLOBAL_GIT_TOKEN_ENV] = 'the-global-one';
    const dir = mkdtempSync(join(tmpdir(), 'repo-sync-http-'));
    try {
      await fetchWith(join(dir, 'c'), 'SOURCE_A_TOKEN', 'github', '/acme/c.git');
      expect(sentCredential()).toBe('x-access-token:the-global-one');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('with neither token set it fails with an authentication error rather than hanging', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-sync-http-'));
    try {
      const remote = `${base}/acme/d.git`;
      const repo = new LocalGitRepo(join(dir, 'd'), {
        credential: { tokenEnv: 'SOURCE_A_TOKEN', hostKind: 'github', remote },
      });
      await repo.init({ initialBranch: 'main' });
      await repo.setRemote(remote);
      await expect(repo.fetch()).rejects.toThrow(/could not read Username|Authentication failed|terminal prompts disabled/i);
      // It never got past the 401: nothing was ever sent with an Authorization header.
      expect(seen.every((r) => !r.auth)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe('the token is not observable', () => {
  it('never appears in argv — only the name of the config that was reset', async () => {
    process.env['SOURCE_A_TOKEN'] = 'token-for-a';
    const filled = await fillCredential({ tokenEnv: 'SOURCE_A_TOKEN', hostKind: 'github', remote: REMOTE }, 'github.com');
    expect(filled.argv).toContain('credential.helper=');
    expect(filled.argv.join(' ')).not.toContain('token-for-a');
    expect(filled.argv.join(' ')).not.toContain('SOURCE_A_TOKEN');
  });

  it('is not in the askpass script on disk, which is owner-only and holds only variable names', () => {
    process.env['SOURCE_A_TOKEN'] = 'token-for-a';
    const cred = resolveGitCredential({ tokenEnv: 'SOURCE_A_TOKEN', remote: REMOTE })!;
    const script = cred.env['GIT_ASKPASS']!;
    expect(script).toBe(askpassScriptPath());
    const text = readFileSync(script, 'utf8');
    expect(text).not.toContain('token-for-a');
    expect(text).toContain('E3_GIT_PASSWORD');
    if (process.platform !== 'win32') {
      // Windows ACLs do not map onto the mode bits, so only assert where they mean something.
      expect(statSync(script).mode & 0o077).toBe(0);
    }
  });

  it("is scrubbed out of a GitError, so it cannot be recorded as a source's last_error", async () => {
    process.env['SOURCE_A_TOKEN'] = 'token-for-a';
    const dir = mkdtempSync(join(tmpdir(), 'repo-sync-cred-'));
    try {
      const repo = new LocalGitRepo(dir, {
        credential: { tokenEnv: 'SOURCE_A_TOKEN', hostKind: 'github', remote: REMOTE },
      });
      await repo.init({ initialBranch: 'main' });
      // A port nothing listens on: git fails at once rather than hanging, and
      // whatever it prints is what would land in `content_sources.last_error`.
      await repo.setRemote('http://127.0.0.1:1/acme/private.git');
      let recorded = '';
      try {
        await repo.fetch();
      } catch (err) {
        expect(err).toBeInstanceOf(GitError);
        const e = err as GitError;
        recorded = [e.message, e.stdout, e.stderr, e.args.join(' ')].join('\n');
      }
      expect(recorded).not.toBe('');
      expect(recorded).not.toContain('token-for-a');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('never reaches the gitconfig of a repository it authenticated for', async () => {
    process.env['SOURCE_A_TOKEN'] = 'token-for-a';
    const dir = mkdtempSync(join(tmpdir(), 'repo-sync-cred-'));
    try {
      const repo = new LocalGitRepo(dir, {
        credential: { tokenEnv: 'SOURCE_A_TOKEN', hostKind: 'github', remote: REMOTE },
      });
      await repo.init({ initialBranch: 'main' });
      await repo.setRemote(REMOTE);
      const config = readFileSync(join(dir, '.git', 'config'), 'utf8');
      expect(config).not.toContain('token-for-a');
      expect(config).toContain(REMOTE);
      // The global config the suite runs against is untouched too.
      const globalPath = process.env['GIT_CONFIG_GLOBAL']!;
      expect(existsSync(globalPath)).toBe(true);
      expect(readFileSync(globalPath, 'utf8')).not.toContain('token-for-a');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('redacts a token wherever it is found, and leaves a value too short to redact alone', () => {
    expect(redactSecrets('fatal: auth failed for abc123', ['abc123'])).toBe('fatal: auth failed for ***');
    expect(redactSecrets('nothing here', ['abc123'])).toBe('nothing here');
    expect(redactSecrets('a a a', ['a'])).toBe('a a a');
  });
});

describe('nothing regressed', () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await makeFixture();
  });
  afterEach(() => fx.cleanup());

  it('a repo configured with a credential still fetches, merges and pushes to a local remote', async () => {
    process.env['SOURCE_A_TOKEN'] = 'token-for-a';
    // The remote is a local path, so `resolveGitCredential` declines to attach
    // anything: the credential must not change how an unauthenticated remote works.
    const a = new LocalGitRepo(fx.a.dir, {
      credential: { tokenEnv: 'SOURCE_A_TOKEN', hostKind: 'github', remote: fx.origin },
    });
    const b = new LocalGitRepo(fx.b.dir, {
      credential: { tokenEnv: 'SOURCE_A_TOKEN', hostKind: 'github', remote: fx.origin },
    });
    write(a, 'concepts/one.md', 'one\n');
    await a.commit(['concepts/one.md'], 'add one', ALICE);
    expect((await a.push()).ok).toBe(true);
    await b.fetch();
    expect((await b.merge('origin/main')).ok).toBe(true);
    expect(await b.git(['show', 'HEAD:concepts/one.md'])).toBe('one');
  });
});
