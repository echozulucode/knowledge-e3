import { defineConfig, devices } from '@playwright/test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// web/package.json is "type": "module", so __dirname is undefined; reconstruct it.
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Playwright e2e config for knowledge-e3.
 *
 * The runner boots both the NestJS server and the Vite dev server via the
 * webServer config. A global setup runs first to reset the test DB and seed
 * the admin user, so tests can sign in deterministically.
 *
 * Test DB lives at server/data/test-e2e.sqlite. It is deleted before every
 * full run. To run a single test against a stale DB (faster local loop),
 * pass KEEP_DB=1.
 */

const repoRoot = resolve(__dirname, '..');
const TEST_DB = resolve(repoRoot, 'server', 'data', 'test-e2e.sqlite');
// Content root (concept files + git mirror) for the e2e server, so runs never
// write into the developer's ./data/wiki. clean-db.js removes it before a run.
const TEST_WIKI = resolve(repoRoot, 'server', 'data', 'test-e2e-wiki');
const SERVER_PORT = '3001'; // distinct from dev server (3000) so dev runs aren't disturbed
const WEB_PORT = '5174';   // distinct from dev web (5173)
const baseURL = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // server is single-tenant; tests share the seeded admin
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  // Bumped from default 30s: first-hit Vite transpilation of routes (esp. the
  // editor route, which pulls in @tiptap/react and @echozedlabs/codec) can take 20–40s
  // on a cold cache. Subsequent tests are fast.
  timeout: 60_000,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: resolve(__dirname, 'tests/e2e/global-setup.ts'),
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      // NestJS server, pointed at the test DB
      // `dev:nowatch`, NOT `dev`. `dev` runs under `node --watch`, and the test
      // database lives at server/data/test-e2e.sqlite — inside the watched tree.
      // The first test that writes to it (signing in writes a session) could
      // restart the API mid-run, and every in-flight request then failed with
      // ECONNREFUSED. That is the "intermittent" e2e flake chased since
      // 2026-09-08 across issues 95, 102, 109 and 111: the suite was racing its
      // own server. A watcher is a developer convenience and has no business in
      // a gate.
      command: 'pnpm --filter @echozedlabs/server dev:nowatch',
      cwd: repoRoot,
      // `readyz`, NOT `healthz`. Until item 13 both returned `'ok'`
      // unconditionally, so this gate could only tell that the port was
      // listening — not that the app behind it could answer. Playwright then
      // started the suite against a server still opening its database and
      // running migrations, which widened the flake window the `dev:nowatch`
      // note below describes. `/readyz` is now bounded by the readiness subset
      // of the system-health checks (database, schema, content root) and
      // returns 503 until they pass, which is exactly the signal a startup gate
      // wants. It stays cheap enough to poll.
      url: `http://localhost:${SERVER_PORT}/api/v1/readyz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DB_URL: TEST_DB,
        GIT_MIRROR_ROOT: TEST_WIKI,
        PORT: SERVER_PORT,
        NODE_ENV: 'development',
        PINO_PRETTY: 'false',
      },
    },
    {
      // Vite dev server, pointed at the test API server via proxy override
      command: 'pnpm --filter @echozedlabs/web dev',
      cwd: repoRoot,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        // Vite reads this to override the dev proxy target.
        VITE_API_PROXY_TARGET: `http://localhost:${SERVER_PORT}`,
        // Vite picks up its own port from CLI in our scripts; we re-export.
        PORT: WEB_PORT,
      },
    },
  ],
});
