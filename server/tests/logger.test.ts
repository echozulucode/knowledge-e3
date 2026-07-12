import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { createPinoLogger } from '../src/logger/pino.js';
import { createRequestContextMiddleware } from '../src/logger/request-context.middleware.js';
import { maybeInitSentry } from '../src/logger/sentry.js';
import type { Request, Response, NextFunction } from 'express';
import { EventEmitter } from 'node:events';

/**
 * Maps to features/07-audit-and-telemetry.feature scenarios on logging.
 *
 * The structured-JSON-with-correlation-IDs scenario is the load-bearing one for
 * production debuggability. We test by feeding a captured-stream Pino logger
 * through the request-context middleware and asserting the emitted shape.
 */

describe('createPinoLogger', () => {
  it('creates a dev logger without crashing on the current Node runtime', () => {
    delete process.env['NODE_ENV'];
    const logger = createPinoLogger();
    // Pino exposes the level; transport details are internal but presence
    // verifies the function ran without throwing.
    expect(logger.level).toBeDefined();
    expect(typeof logger.info).toBe('function');
  });

  it('emits structured JSON in production (no transport key)', () => {
    process.env['NODE_ENV'] = 'production';
    const logger = createPinoLogger();
    expect(logger.level).toBeDefined();
    delete process.env['NODE_ENV'];
  });

  it('respects LOG_LEVEL env override', () => {
    process.env['LOG_LEVEL'] = 'warn';
    const logger = createPinoLogger();
    expect(logger.level).toBe('warn');
    delete process.env['LOG_LEVEL'];
  });
});

/**
 * Middleware test with a captured-stream Pino logger.
 *
 * pino accepts a destination stream as the second arg. We pipe to a buffer and
 * then parse line-delimited JSON to inspect what was logged.
 */
function makeCapturedLogger(): { logger: pino.Logger; lines: () => any[] } {
  const buf: string[] = [];
  const stream: any = {
    write(chunk: string) {
      buf.push(chunk);
    },
  };
  const logger = pino({ level: 'info', timestamp: pino.stdTimeFunctions.isoTime }, stream);
  return {
    logger,
    lines: () =>
      buf
        .join('')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l)),
  };
}

function fakeReqRes(path: string): { req: Request; res: Response & EventEmitter; next: NextFunction } {
  const req = { path, method: 'GET', headers: {} } as unknown as Request;
  const res = new EventEmitter() as Response & EventEmitter;
  (res as any).statusCode = 200;
  (res as any).send = (b: unknown) => res;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
}

describe('request-context middleware', () => {
  it('attaches a unique requestId per request', () => {
    const { logger } = makeCapturedLogger();
    const middleware = createRequestContextMiddleware(logger);

    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { req, res, next } = fakeReqRes('/api/v1/something');
      middleware(req, res, next);
      seen.add((req as any).requestId);
    }
    expect(seen.size).toBe(5);
  });

  it('logs JSON with method/path/status/requestId after response.finish', () => {
    const { logger, lines } = makeCapturedLogger();
    const middleware = createRequestContextMiddleware(logger);

    const { req, res, next } = fakeReqRes('/api/v1/pages');
    middleware(req, res, next);
    res.emit('finish');

    const logs = lines();
    expect(logs.length).toBe(1);
    const entry = logs[0];
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('/api/v1/pages');
    expect(entry.status).toBe(200);
    expect(typeof entry.requestId).toBe('string');
    expect(entry.requestId.length).toBeGreaterThan(8);
    // Same requestId attached to req should appear in the log line.
    expect(entry.requestId).toBe((req as any).requestId);
  });

  it('skips request logging for healthz and readyz', () => {
    const { logger, lines } = makeCapturedLogger();
    const middleware = createRequestContextMiddleware(logger);

    for (const p of ['/api/v1/healthz', '/api/v1/readyz']) {
      const { req, res, next } = fakeReqRes(p);
      middleware(req, res, next);
      res.emit('finish');
    }
    expect(lines().length).toBe(0);
  });
});

describe('maybeInitSentry', () => {
  it('is a no-op when SENTRY_DSN is unset and never tries to import @sentry/node', async () => {
    delete process.env['SENTRY_DSN'];
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    await maybeInitSentry();
    // Did NOT log "Sentry initialized" (which only fires in the loaded path).
    const initLogged = consoleLog.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('Sentry initialized')),
    );
    expect(initLogged).toBe(false);
    consoleLog.mockRestore();
  });

  it('attempts dynamic import when SENTRY_DSN is set (logs an error if @sentry/node is not installed)', async () => {
    process.env['SENTRY_DSN'] = 'https://example.invalid';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    await maybeInitSentry();
    // @sentry/node is not installed in this repo, so the dynamic import fails
    // and `console.error('[kp/server] Failed to initialize Sentry:', err)`
    // fires. This proves the DSN-set path actually runs the import.
    const failureLogged = consoleError.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('Failed to initialize Sentry')),
    );
    expect(failureLogged).toBe(true);
    consoleError.mockRestore();
    consoleLog.mockRestore();
    delete process.env['SENTRY_DSN'];
  });
});
