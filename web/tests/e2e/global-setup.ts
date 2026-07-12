import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Global setup for Playwright e2e tests.
 *
 * 1. Delete the test DB (unless KEEP_DB=1, which is handy for local iteration).
 * 2. Run the server's seed script against the test DB so the admin exists when
 *    the webServer subprocesses come up.
 * 3. Playwright's webServer config then boots the NestJS + Vite servers
 *    pointed at the test DB.
 */
async function globalSetup(): Promise<void> {
  const repoRoot = resolve(__dirname, '..', '..', '..');
  const testDb = resolve(repoRoot, 'server', 'data', 'test-e2e.sqlite');
  const dataDir = dirname(testDb);

  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  // Note: DB cleanup happens in tests/e2e/clean-db.js before this runs, because
  // Playwright launches `webServer` *before* invoking globalSetup — by the time
  // we get here the API server is already holding the SQLite file open.

  // Run seed against the test DB. The seed script is idempotent. Playwright
  // starts webServer processes before globalSetup, so the API process can still
  // be finishing SQLite migrations when seed begins. Retry briefly so failures
  // identify real seed/product-path problems instead of transient DB locks.
  let seed = spawnSeed(repoRoot, testDb);
  for (let attempt = 2; seed.status !== 0 && attempt <= 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    seed = spawnSeed(repoRoot, testDb);
  }

  if (seed.status !== 0) {
    throw new Error(`Seed script failed (exit ${seed.status})`);
  }
  // eslint-disable-next-line no-console
  console.log(`[e2e setup] seeded admin in ${testDb}`);
}

function spawnSeed(repoRoot: string, testDb: string): ReturnType<typeof spawnSync> {
  return spawnSync('pnpm', ['--filter', '@echozedlabs/server', 'seed'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      DB_URL: testDb,
      SEED_ADMIN_USERNAME: 'admin',
      SEED_ADMIN_PASSWORD: 'admin-dev-password',
      SEED_ADMIN_EMAIL: 'admin@local',
    },
    shell: process.platform === 'win32',
  });
}

export default globalSetup;
