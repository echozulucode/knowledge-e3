import pino from 'pino';

/**
 * Create and return a Pino logger instance configured for the current environment.
 *
 * In development: pretty-prints JSON logs to stdout with colors.
 * In production: emits structured JSON logs to stdout.
 *
 * Log level is controlled by the LOG_LEVEL environment variable (default: 'info').
 * The Pino instance is passed to NestJS's LoggerService and also used for direct calls.
 */
export function createPinoLogger(): pino.Logger {
  const isDev = process.env['NODE_ENV'] !== 'production';
  const logLevel = process.env['LOG_LEVEL'] ?? 'info';

  const baseConfig: pino.LoggerOptions = {
    level: logLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  const majorNodeVersion = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  const prettyPreference = process.env['PINO_PRETTY'];
  const usePrettyTransport =
    isDev &&
    prettyPreference !== 'false' &&
    // Node 26 currently trips thread-stream/pino-pretty with:
    //   Error: this should not happen: undefined
    // Keep dev boot reliable on bleeding-edge Node. Developers can still opt in
    // explicitly if/when the upstream transport stack is fixed.
    (majorNodeVersion < 26 || prettyPreference === 'true');

  if (usePrettyTransport) {
    // Pretty-print in dev for readability when the local Node/runtime supports
    // pino-pretty's worker transport reliably.
    return pino(
      {
        ...baseConfig,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            singleLine: false,
            translateTime: 'SYS:HH:MM:ss Z',
            ignore: 'pid,hostname',
          },
        },
      },
    );
  }

  // Structured JSON in production
  return pino(baseConfig);
}
