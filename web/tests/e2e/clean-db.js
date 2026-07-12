/**
 * Pre-step for `pnpm test:e2e`: delete the test SQLite DB before Playwright
 * launches the webServer. Must run before any server holds open file handles
 * — Playwright runs `webServer` *before* `globalSetup`, so the cleanup can't
 * live in globalSetup.
 *
 * Honours KEEP_DB=1 to skip cleanup for fast local iteration.
 */
import { rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');
const testDb = resolve(repoRoot, 'server', 'data', 'test-e2e.sqlite');

if (process.env.KEEP_DB) {
  console.log('[e2e clean-db] KEEP_DB set — skipping cleanup');
  process.exit(0);
}

for (const f of [testDb, `${testDb}-shm`, `${testDb}-wal`, `${testDb}-journal`]) {
  if (existsSync(f)) {
    try {
      rmSync(f, { force: true });
      console.log(`[e2e clean-db] removed ${f}`);
    } catch (e) {
      console.error(`[e2e clean-db] failed to remove ${f}: ${e.message}`);
      process.exit(1);
    }
  }
}
