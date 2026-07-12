import { Injectable, LoggerService } from '@nestjs/common';
import type pino from 'pino';

/**
 * A NestJS LoggerService implementation that delegates all logging calls to Pino.
 *
 * This allows NestJS's internal logger (and any code that uses NestJS's Logger.log/error/warn/debug/verbose)
 * to emit structured logs through Pino, ensuring all application logs flow through the same JSON stream.
 */
@Injectable()
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: pino.Logger) {}

  log(message: string, context?: string): void {
    this.logger.info({ context }, message);
  }

  error(message: string, stack?: string, context?: string): void {
    this.logger.error({ context, stack }, message);
  }

  warn(message: string, context?: string): void {
    this.logger.warn({ context }, message);
  }

  debug(message: string, context?: string): void {
    this.logger.debug({ context }, message);
  }

  verbose(message: string, context?: string): void {
    this.logger.trace({ context }, message);
  }
}
