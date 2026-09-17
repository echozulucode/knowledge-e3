/**
 * The git mirror's commit-debounce window is per-instance (§7.1 "tune the commit
 * debounce window"). Before this it was two module constants with no way in:
 * `MirrorOptions.quietMs`/`maxMs` existed but no caller ever set them, so every
 * deployment — laptop self-host and ephemeral-disk cloud demo alike — committed
 * on the same 2s/15s cadence.
 *
 * The window bounds how long an indexed write sits with no commit behind it,
 * which is exactly the gap a crash leaves for the outbox replay to close. The
 * DEFAULT is deliberately left alone here; this only makes it settable.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { commitWindow, loadServerConfig, resetServerConfig } from '../src/config/server-config.js';
import { GitRevisionMirrorAdapter } from '../src/storage/git-revision-mirror.adapter.js';

/** Point the loader at a throwaway config file holding `yaml`. */
function withConfig(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'e3-window-'));
  const file = join(dir, 'knowledge-e3.config.yaml');
  writeFileSync(file, yaml, 'utf8');
  process.env['KNOWLEDGE_E3_CONFIG'] = file;
  resetServerConfig();
  return dir;
}

describe('git mirror commit window: configuration', () => {
  const temps: string[] = [];

  afterEach(() => {
    delete process.env['KNOWLEDGE_E3_CONFIG'];
    delete process.env['GIT_COMMIT_QUIET_MS'];
    delete process.env['GIT_COMMIT_MAX_MS'];
    resetServerConfig();
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('is absent by default, so the adapter keeps its own 2s/15s', () => {
    resetServerConfig();
    expect(loadServerConfig().git.commitQuietMs).toBeUndefined();
    expect(commitWindow()).toEqual({ quietMs: undefined, maxMs: undefined });
  });

  it('reads ms, "1500ms", "2s" and "5m" from the config file', () => {
    temps.push(withConfig('git: { commit: { quiet: 1500, max: 2s } }\n'));
    expect(loadServerConfig().git).toMatchObject({ commitQuietMs: 1500, commitMaxMs: 2000 });

    temps.push(withConfig('git: { commit: { quiet: "750ms", max: "5m" } }\n'));
    expect(loadServerConfig().git).toMatchObject({ commitQuietMs: 750, commitMaxMs: 300_000 });
  });

  it('env overrides the file, per half', () => {
    temps.push(withConfig('git: { commit: { quiet: 1500, max: 9s } }\n'));
    process.env['GIT_COMMIT_MAX_MS'] = '3000';
    // Only the cap was overridden; the quiet period still comes from the file.
    expect(commitWindow()).toEqual({ quietMs: 1500, maxMs: 3000 });
  });

  it('rejects a malformed window at load rather than silently using the default', () => {
    temps.push(withConfig('git: { commit: { quiet: "2 sec" } }\n'));
    expect(() => loadServerConfig()).toThrow(/git\.commit\.quiet/);

    temps.push(withConfig('git: { commit: { max: 0 } }\n'));
    expect(() => loadServerConfig()).toThrow(/git\.commit\.max/);
  });
});

describe('git mirror commit window: the adapter honours it', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let dir: string;

  afterEach(async () => {
    await app?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('commits on the configured quiet period, with no explicit flush', async () => {
    app = await makeApp();
    db = app.get<Kysely<Database>>(KYSELY);
    dir = mkdtempSync(join(tmpdir(), 'e3-window-adapter-'));

    // Two adapters, compared against EACH OTHER rather than against the wall
    // clock. The previous version of this test polled for 1.5s and argued that a
    // commit inside that budget could only have come from the configured 25ms
    // window, because the default is 2s — correct logic, but it left ~500ms of
    // headroom on a Windows box spawning git under a full parallel suite, and it
    // failed intermittently (three sightings, issue 109).
    //
    // The relative form has no such margin to lose: both adapters run in the same
    // process under the same load, so whatever slows one slows the other. `slow`
    // is given a quiet window far longer than any plausible duration of this
    // test, so if the option is honoured it CANNOT have committed by the time
    // `fast` has. If the option is ignored, both fall back to the same default
    // and the final assertion fails.
    const fastDir = join(dir, 'fast');
    const slowDir = join(dir, 'slow');
    mkdirSync(join(fastDir, 'assets'), { recursive: true });
    mkdirSync(join(slowDir, 'assets'), { recursive: true });
    const fast = new GitRevisionMirrorAdapter(fastDir, db, { quietMs: 25, maxMs: 100 });
    const slow = new GitRevisionMirrorAdapter(slowDir, db, { quietMs: 60_000, maxMs: 120_000 });

    // The asset door, because it schedules the same debounced commit with no
    // index row of its own to satisfy.
    writeFileSync(join(fastDir, 'assets', 'window.png'), 'PNGDATA', 'utf8');
    writeFileSync(join(slowDir, 'assets', 'window.png'), 'PNGDATA', 'utf8');
    await Promise.all([fast.notifyAssetsChanged(), slow.notifyAssetsChanged()]);

    const logOf = (at: string): string => {
      try {
        // stderr ignored: `git log` on a repo with no commits yet is the normal
        // state of this loop and would otherwise spray the suite output.
        return execFileSync('git', ['-C', at, 'log', '--oneline'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        return '';
      }
    };

    // Generous, because this deadline now only bounds the test's patience; it no
    // longer carries the argument.
    const deadline = Date.now() + 20_000;
    let fastLog = '';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      fastLog = logOf(fastDir);
      if (fastLog.includes('update assets')) break;
    }

    expect(fastLog).toContain('knowledge-e3: update assets');
    // The whole point: the 60s window has not elapsed, so a configured quiet
    // period is being honoured rather than ignored in favour of the default.
    expect(logOf(slowDir)).toBe('');
  });
});
