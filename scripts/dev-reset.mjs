#!/usr/bin/env node
/**
 * Set the local DEVELOPMENT instance aside so `seed` can build a fresh one.
 *
 * Why this exists: `seed` only writes what is absent (users, config keys, items
 * whose slugs are free), which is right for an instance people use and wrong for
 * a dev instance seeded before the seed changed. A dev database seeded before
 * the home plan's revision 2 keeps its "News" Section, its icon-less pins and its
 * cover-less stories forever. Nothing here is used for real yet (Eric,
 * 2026-09-12: "no need for backward compatibility"), so the honest fix is a fresh
 * seed — but a reset that DELETES is one typo away from losing work, so this
 * MOVES the database and the content working trees into a timestamped backup
 * folder and deletes nothing.
 *
 * It only ever touches the dev defaults the server resolves when nothing is
 * configured — `server/data/kp.sqlite` (+ `-wal`, `-shm`) and `server/data/wiki`.
 * It refuses to run when any setting could point the server somewhere else
 * (DB_URL, CONTENT_ROOT, GIT_MIRROR_ROOT, KNOWLEDGE_E3_CONFIG, or a
 * `server/knowledge-e3.config.yaml`), because then "the dev data" is not a path
 * this script can know. The e2e gate's files (`test-e2e*`) and the review
 * instance's (`review-e3*`) are never touched.
 *
 *   just dev-reset          # move aside, then seed
 *   node scripts/dev-reset.mjs --data <dir>   # operate on another data dir (used to test this script)
 */
import { existsSync, mkdirSync, renameSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const dataFlag = args.indexOf('--data');
const repoRoot = resolve(import.meta.dirname, '..');
const dataDir = dataFlag >= 0 ? resolve(args[dataFlag + 1] ?? '') : join(repoRoot, 'server', 'data');

if (dataFlag < 0) {
  const overrides = ['DB_URL', 'CONTENT_ROOT', 'GIT_MIRROR_ROOT', 'KNOWLEDGE_E3_CONFIG'].filter((k) => process.env[k]);
  if (existsSync(join(repoRoot, 'server', 'knowledge-e3.config.yaml'))) overrides.push('server/knowledge-e3.config.yaml');
  if (overrides.length) {
    console.error(`dev-reset: refusing — ${overrides.join(', ')} can point the server at data this script does not know about.`);
    process.exit(2);
  }
}

const targets = ['kp.sqlite', 'kp.sqlite-wal', 'kp.sqlite-shm', 'wiki'].filter((name) => existsSync(join(dataDir, name)));
if (targets.length === 0) {
  console.log(`dev-reset: nothing to move in ${dataDir}; seeding a fresh instance.`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = join(dataDir, `backup-${stamp}`);
mkdirSync(backup, { recursive: true });

const moved = [];
try {
  for (const name of targets) {
    renameSync(join(dataDir, name), join(backup, name));
    moved.push(name);
  }
} catch (err) {
  // Put back whatever already moved, so a failure never leaves half an instance.
  for (const name of moved.reverse()) {
    try {
      renameSync(join(backup, name), join(dataDir, name));
    } catch {
      /* reported below */
    }
  }
  try {
    rmdirSync(backup); // only succeeds when empty, i.e. everything went back
  } catch {
    /* something could not be restored; the backup folder keeps it */
  }
  const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
  const hint = code === 'EBUSY' || code === 'EPERM' ? ' The files are in use — stop `just dev` (and anything else using the dev server) first.' : '';
  console.error(`dev-reset: could not move ${targets.join(', ')} (${code || String(err)}).${hint} Nothing was changed.`);
  process.exit(1);
}

console.log(`dev-reset: moved ${moved.join(', ')} to ${backup}`);
console.log('dev-reset: to undo, stop the dev server and move them back.');
