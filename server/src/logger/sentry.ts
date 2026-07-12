/**
 * Lazy Sentry initialization hook for optional error monitoring.
 *
 * This module provides `maybeInitSentry()`, which initializes Sentry only if the
 * `SENTRY_DSN` environment variable is set. The `@sentry/node` package is NOT
 * a static dependency — it is dynamically imported if and only if Sentry is enabled.
 *
 * Production deployment note:
 * To enable Sentry error monitoring on a production deployment, ensure that:
 * 1. `SENTRY_DSN` environment variable is set with the correct DSN.
 * 2. `@sentry/node` package is installed: `pnpm add @sentry/node`
 *
 * If `SENTRY_DSN` is not set, this function is a no-op and the Sentry SDK is never loaded.
 */

export async function maybeInitSentry(): Promise<void> {
  const sentryDsn = process.env['SENTRY_DSN'];
  if (!sentryDsn) {
    // Sentry is not enabled; skip initialization.
    return;
  }

  try {
    // Dynamically import Sentry only if enabled. The specifier is held in a
    // variable so TypeScript does not try to resolve `@sentry/node` at build
    // time — the package is an optional peer dep that may not be installed.
    const sentryModule = '@sentry/node';
    const Sentry = (await import(sentryModule)) as {
      init: (opts: Record<string, unknown>) => void;
    };

    Sentry.init({
      dsn: sentryDsn,
      environment: process.env['NODE_ENV'] ?? 'development',
      release: process.env['RELEASE_TAG'] ?? 'dev',
      tracesSampleRate: 1.0,
    });

    // eslint-disable-next-line no-console
    console.log('[kp/server] Sentry initialized');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[kp/server] Failed to initialize Sentry:', err);
    // Do not fail the application startup if Sentry initialization fails.
  }
}
