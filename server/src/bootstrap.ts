import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import express from 'express';
import { AppModule } from './app.module.js';
import { NestPinoLogger } from './logger/nest-pino-logger.js';
import { createPinoLogger } from './logger/pino.js';
import { createRequestContextMiddleware } from './logger/request-context.middleware.js';
import { maybeInitSentry } from './logger/sentry.js';

export async function createApp(): Promise<INestApplication> {
  // Initialize Sentry before creating the app (if SENTRY_DSN is set).
  await maybeInitSentry();

  // Create the Pino logger instance.
  const pinoLogger = createPinoLogger();

  const app = await NestFactory.create(AppModule, {
    logger: new NestPinoLogger(pinoLogger),
  });

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

  // OKF bundle imports are whole-library payloads — parse them with a generous
  // limit, scoped to that route, before the global cap below claims the body.
  app.use('/api/v1/okf/import', express.json({ limit: '50mb' }));
  // Image uploads arrive as a raw binary body (no multipart dependency).
  app.use('/api/v1/images', express.raw({ type: () => true, limit: '25mb' }));

  // Enforce 100 KB limit on request bodies (for bug-report size cap).
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ limit: '100kb', extended: true }));

  // Attach request-context middleware to log every request.
  app.use(createRequestContextMiddleware(pinoLogger));

  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
    }),
  );
  return app;
}
