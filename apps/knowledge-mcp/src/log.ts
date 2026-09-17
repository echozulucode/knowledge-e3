/**
 * Logging for a stdio MCP server.
 *
 * stdout IS the protocol channel: one stray line there corrupts the JSON-RPC
 * stream, so every log line goes to stderr. Every line also passes through the
 * redactor, which replaces any registered secret (a source's token, read from
 * its environment variable) before it can be written — a defence in depth for
 * the rule that a token never appears in logs, whatever message an upstream
 * library or server put it in.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LoggerOptions {
  /** Where lines go. Default: `process.stderr`. Never stdout. */
  write?: (line: string) => void;
  /** Lowest level written. Default `info` (`KNOWLEDGE_MCP_LOG_LEVEL` overrides in the CLI). */
  level?: LogLevel;
  redactor?: Redactor;
}

/** Replaces registered secrets with `[redacted]` in any text. */
export class Redactor {
  private readonly secrets = new Set<string>();

  /** Register a secret. Very short values are ignored: redacting "a" would mangle every line. */
  add(secret: string | undefined): void {
    if (secret && secret.length >= 4) this.secrets.add(secret);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join('[redacted]');
    return out;
  }
}

/** The process-wide redactor every source registers its token with. */
export const redactor = new Redactor();

export function createLogger(opts: LoggerOptions = {}): Logger {
  const write = opts.write ?? ((line: string) => void process.stderr.write(line));
  const min = LEVELS[opts.level ?? 'info'];
  const red = opts.redactor ?? redactor;
  const emit = (level: LogLevel, message: string) => {
    if (LEVELS[level] < min) return;
    write(`[knowledge-mcp] ${level}: ${red.redact(message)}\n`);
  };
  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
  };
}

export function parseLogLevel(value: string | undefined): LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error' ? value : 'info';
}

/**
 * Point `console.log/info/debug` at stderr for the life of the process, so a
 * library that logs with `console.log` cannot write into the protocol stream.
 */
export function guardStdout(): void {
  const toStderr = (...args: unknown[]) => {
    process.stderr.write(`${redactor.redact(args.map((a) => (typeof a === 'string' ? a : safeInspect(a))).join(' '))}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

function safeInspect(value: unknown): string {
  try {
    return value instanceof Error ? (value.stack ?? value.message) : JSON.stringify(value);
  } catch {
    return String(value);
  }
}
