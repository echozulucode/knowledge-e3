/**
 * @echozedlabs/knowledge-mcp — read-only stdio MCP server over configured knowledge sources.
 * The published package is the bundled `knowledge-mcp` executable; these exports exist for tests and embedding.
 */
export { main, parseArgs, resolveConfig, HELP } from './cli.js';
export { loadConfigFile, validateConfig, foldersToSources, ConfigError, type KnowledgeMcpConfig, type SourceConfig } from './config.js';
export { createKnowledgeMcp, createSources, serveStdio, type KnowledgeMcp } from './server.js';
export { MultiSourceBackend, type AppCallContext } from './backend.js';
export { createAppTools, type AppTool } from './tools.js';
export { createLogger, Redactor, redactor, type Logger } from './log.js';
export { VERSION } from './version.js';
