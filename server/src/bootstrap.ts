import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import express from 'express';
import { AppModule } from './app.module.js';
import { assertAuthenticationEnabled } from './auth/auth-mode.js';
import { trustProxySetting } from './config/server-config.js';
import { NestPinoLogger } from './logger/nest-pino-logger.js';
import { createPinoLogger } from './logger/pino.js';
import { createRequestContextMiddleware } from './logger/request-context.middleware.js';
import { maybeInitSentry } from './logger/sentry.js';

export interface ConfigureAppOptions {
  /** Per-request logging middleware. Omitted in tests (noise), set in dev/prod. */
  requestContext?: express.RequestHandler;
  /**
   * Directory holding the built SPA. `null` disables SPA serving entirely
   * (tests, API-only deployments). Defaults to $WEB_DIST or ./web/dist.
   */
  webDist?: string | null;
  onWebDistServed?: (dir: string) => void;
}

/**
 * Wire the HTTP stack: body parsers, cookies, the `/assets` URL mapping, SPA
 * serving, the global prefix, and validation.
 *
 * This is shared by the real bootstrap AND the e2e harness on purpose. It used
 * to be duplicated by hand in `tests/helpers.ts` ("match bootstrap"), the two
 * drifted, and the result was a production-only 404 on `/assets/<file>` that the
 * whole e2e suite was structurally incapable of catching. One definition, so
 * tests exercise the stack that actually ships.
 */
export function configureApp(app: INestApplication, opts: ConfigureAppOptions = {}): void {
  // Which proxy hops may report the client address (issue 41 follow-up). Set
  // before any middleware reads `req.ip`: the sign-in throttle and the MCP rate
  // limiter both key on it. Off by default; see `TrustProxySetting`.
  const trustProxy = trustProxySetting();
  if (trustProxy !== false) (app.getHttpAdapter().getInstance() as express.Express).set('trust proxy', trustProxy);

  // A full-fidelity OKF archive is uploaded as raw `.tar.gz` bytes. Registered
  // BEFORE the `/okf/import` JSON parser (a path prefix of this route) so it
  // claims the binary body first instead of the JSON parser choking on it.
  app.use('/api/v1/okf/import/archive', express.raw({ type: () => true, limit: '50mb' }));
  // OKF bundle imports are whole-library payloads — parse them with a generous
  // limit, scoped to that route, before the global cap below claims the body.
  app.use('/api/v1/okf/import', express.json({ limit: '50mb' }));
  // The import doors' dry runs take the very same bodies, so they get the very
  // same parsers and limits — a bundle that fits the import but is refused by its
  // own validate would make "validate first" impossible. Same ordering rule:
  // `validate/archive` before its `validate` prefix.
  app.use('/api/v1/okf/validate/archive', express.raw({ type: () => true, limit: '50mb' }));
  app.use('/api/v1/okf/validate', express.json({ limit: '50mb' }));
  // Image uploads arrive as a raw binary body (no multipart dependency).
  app.use('/api/v1/images', express.raw({ type: () => true, limit: '25mb' }));
  // Host webhooks are verified by an HMAC over the exact bytes sent.
  app.use('/api/v1/sync/webhook', express.raw({ type: () => true, limit: '1mb' }));

  // Enforce 100 KB limit on request bodies (for bug-report size cap).
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ limit: '100kb', extended: true }));

  if (opts.requestContext) app.use(opts.requestContext);

  app.use(cookieParser());

  // User content (images, attachments) is addressed as `/assets/<file>`. That
  // URL is embedded in Markdown committed to git, so it is the canonical form
  // and must resolve wherever a bundle is served; the API route itself lives
  // behind the global prefix. Map one onto the other for every deployment shape
  // (dev proxy, container, API-only) rather than in any single one of them.
  //
  // Must precede the SPA fallback below: a browser navigating straight to an
  // attachment sends `Accept: text/html`, and would otherwise be handed index.html.
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (req.url.startsWith('/assets/')) req.url = `/api/v1${req.url}`;
    next();
  });

  // Serve the built web client (SPA) when present. The production container
  // copies web/dist into the image and sets WEB_DIST; in dev the web app runs
  // under Vite instead, so this whole block is a no-op (the dir won't exist).
  const webDist =
    opts.webDist === null
      ? null
      : (opts.webDist ?? process.env['WEB_DIST'] ?? resolve(process.cwd(), 'web/dist'));
  if (webDist && existsSync(resolve(webDist, 'index.html'))) {
    // Vite build output (JS/CSS) lives under /static/ — see web/vite.config.ts,
    // which keeps it clear of the /assets/ user-content space rewritten above.
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    // ...and any other non-API GET that accepts HTML falls back to index.html
    // so client-side routes (e.g. /p/:slug) load the SPA. /api/* is left to Nest.
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      if (!req.headers.accept?.includes('text/html')) return next();
      res.sendFile(resolve(webDist, 'index.html'));
    });
    opts.onWebDistServed?.(webDist);
  }

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
    }),
  );
}

export async function createApp(): Promise<INestApplication> {
  // Before anything else: a leftover `auth.mode: disabled` stops the boot with
  // the fix in one message, not after a screen of Nest module logs.
  // (AuthService.onModuleInit repeats the check for other harnesses.)
  assertAuthenticationEnabled();

  // Initialize Sentry before creating the app (if SENTRY_DSN is set).
  await maybeInitSentry();

  // Create the Pino logger instance.
  const pinoLogger = createPinoLogger();

  const app = await NestFactory.create(AppModule, {
    logger: new NestPinoLogger(pinoLogger),
  });
  app.enableShutdownHooks();

  // Check for production cookie security config.
  if (process.env['NODE_ENV'] === 'production') {
    const hasHttpsOnly = process.env['HTTPS_ONLY'] === '1';
    const forceInsecure = process.env['FORCE_INSECURE_COOKIES'] === '1';
    if (!hasHttpsOnly && !forceInsecure) {
      pinoLogger.warn(
        'Cookie Secure flag may not be set in production. Set HTTPS_ONLY=1 if you are behind TLS termination, or FORCE_INSECURE_COOKIES=1 only for tests.',
      );
    }
  }

  configureApp(app, {
    requestContext: createRequestContextMiddleware(pinoLogger),
    onWebDistServed: (dir) => pinoLogger.info(`serving web client from ${dir}`),
  });
  return app;
}
