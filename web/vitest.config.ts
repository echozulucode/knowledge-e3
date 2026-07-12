import { defineConfig } from 'vitest/config';

/**
 * Vitest config for web/ unit tests.
 *
 * Distinct from playwright.config.ts: vitest is for fast in-process unit and
 * component tests; Playwright is for full-stack browser-driven e2e.
 *
 * Excludes the e2e folder so a `pnpm --filter @echozedlabs/web test` doesn't try to
 * run Playwright specs through Vitest.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/main.tsx',
        'src/router.tsx',
      ],
    },
  },
});
