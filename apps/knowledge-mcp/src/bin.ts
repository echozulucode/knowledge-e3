/**
 * Executable entry (bundled to `dist/knowledge-mcp.js` with a `#!/usr/bin/env node` banner).
 * Kept separate from `cli.ts` so tests can import the CLI without starting it.
 */
import { main } from './cli.js';

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err: unknown) => {
    process.stderr.write(`[knowledge-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
