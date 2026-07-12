import { Module, Global } from '@nestjs/common';
import type pino from 'pino';
import { createPinoLogger } from './pino.js';
import { NestPinoLogger } from './nest-pino-logger.js';

/**
 * Global logger module that provides a Pino instance and a NestJS LoggerService.
 *
 * Exports:
 * - A Pino logger instance (injected as pino.Logger)
 * - NestPinoLogger (the NestJS LoggerService)
 *
 * This module is global so it can be injected anywhere in the application.
 */
@Global()
@Module({
  providers: [
    {
      provide: 'PINO_LOGGER',
      useFactory: createPinoLogger,
    },
    {
      provide: 'pino.Logger',
      useFactory: (pinoLogger: pino.Logger) => pinoLogger,
      inject: ['PINO_LOGGER'],
    },
    {
      provide: NestPinoLogger,
      useFactory: (pinoLogger: pino.Logger) => new NestPinoLogger(pinoLogger),
      inject: ['PINO_LOGGER'],
    },
  ],
  exports: ['PINO_LOGGER', 'pino.Logger', NestPinoLogger],
})
export class LoggerModule {}
