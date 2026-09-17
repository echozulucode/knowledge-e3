/**
 * `knowledge-mcp` — a read-only stdio MCP server over configured knowledge sources.
 *
 *   knowledge-mcp --config knowledge-mcp.yaml
 *   knowledge-mcp --folder ./notes --folder ./handbook
 *   KNOWLEDGE_MCP_CONFIG=knowledge-mcp.yaml knowledge-mcp
 *
 * stdout carries only MCP JSON-RPC once the server starts; logs go to stderr.
 * (`--help` and `--version` print to stdout and exit without starting a server.)
 */
import { ConfigError, foldersToSources, loadConfigFile, type KnowledgeMcpConfig } from './config.js';
import { createLogger, guardStdout, parseLogLevel, type Logger } from './log.js';
import { PathSafetyError } from './paths.js';
import { createKnowledgeMcp, serveStdio } from './server.js';
import { PACKAGE_NAME, VERSION } from './version.js';

export const HELP = `${PACKAGE_NAME} ${VERSION}
Read-only MCP server (stdio) over local knowledge folders, local git working
trees and, optionally, Knowledge E3 servers. Keyword search only.

Usage:
  knowledge-mcp --config <file>          YAML or JSON config (see README)
  knowledge-mcp --folder <path> [...]    zero-config: serve these folders
  knowledge-mcp --help | --version

Options:
  --config <file>   Config file. Default: $KNOWLEDGE_MCP_CONFIG when set.
  --folder <path>   A local folder source; repeatable; added to any config.
  --help            Show this help.
  --version         Show the version.

Environment:
  KNOWLEDGE_MCP_CONFIG     Config file when --config is not given.
  KNOWLEDGE_MCP_LOG_LEVEL  debug | info | warn | error (default info). Logs go to stderr.
  <token_env>              A server source's personal access token, in the variable
                           its config names. Never put a token in the config file.
`;

export interface ParsedArgs {
  help: boolean;
  version: boolean;
  config?: string;
  folders: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { help: false, version: false, folders: [] };
  const problems: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        problems.push(`${flag} needs a value`);
        return undefined;
      }
      i += 1;
      return next;
    };
    switch (flag) {
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--version':
      case '-v':
        out.version = true;
        break;
      case '--config': {
        const v = value();
        if (v !== undefined) {
          if (out.config !== undefined) problems.push('--config may be given once');
          out.config = v;
        }
        break;
      }
      case '--folder': {
        const v = value();
        if (v !== undefined) out.folders.push(v);
        break;
      }
      default:
        problems.push(`unknown argument: ${arg}`);
    }
  }
  if (problems.length) throw new ConfigError(problems);
  return out;
}

/** Resolve the effective config from flags and environment. */
export function resolveConfig(args: ParsedArgs, env: NodeJS.ProcessEnv, cwd: string): KnowledgeMcpConfig {
  const file = args.config ?? (env['KNOWLEDGE_MCP_CONFIG']?.trim() || undefined);
  const base: KnowledgeMcpConfig = file ? loadConfigFile(file) : { sources: [] };
  const folders = foldersToSources(args.folders, cwd, base.sources.map((s) => s.id));
  const sources = [...base.sources, ...folders];
  if (!sources.length) {
    throw new ConfigError(['no sources configured: pass --config <file>, set KNOWLEDGE_MCP_CONFIG, or pass --folder <path>']);
  }
  return { sources };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let args: ParsedArgs;
  const logger: Logger = createLogger({ level: parseLogLevel(env['KNOWLEDGE_MCP_LOG_LEVEL']) });
  try {
    args = parseArgs(argv);
  } catch (err) {
    return fail(err, logger);
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  // From here on stdout belongs to the protocol.
  guardStdout();
  try {
    const config = resolveConfig(args, env, process.cwd());
    const mcp = await createKnowledgeMcp(config, logger);
    await serveStdio(mcp, logger);
    return -1; // keep running until stdin closes
  } catch (err) {
    return fail(err, logger);
  }
}

function fail(err: unknown, logger: Logger): number {
  if (err instanceof ConfigError || err instanceof PathSafetyError) {
    process.stderr.write(`${err.message}\nRun knowledge-mcp --help for usage.\n`);
    return 2;
  }
  logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  return 1;
}
