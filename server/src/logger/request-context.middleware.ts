import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import type pino from 'pino';

/**
 * Express middleware that attaches a request-scoped correlation ID and logs each HTTP request
 * after the response completes.
 *
 * Logs the request at INFO level with: method, path, status, duration (ms), user id (if authenticated),
 * and request id. Excludes noisy health-check paths from logging.
 */
export function createRequestContextMiddleware(logger: pino.Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Generate a unique correlation ID for this request.
    const requestId = randomUUID();
    (req as any).requestId = requestId;

    const startTime = Date.now();
    const originalSend = res.send.bind(res);

    // Log after the response is sent.
    res.on('finish', () => {
      const duration = Date.now() - startTime;

      // Skip noisy health-check paths
      if (req.path === '/api/v1/healthz' || req.path === '/api/v1/readyz') {
        return;
      }

      // Extract user id if authenticated
      const userId = (req as any).user?.id || null;

      logger.info(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration,
          userId,
          requestId,
        },
        'HTTP request completed',
      );
    });

    next();
  };
}
