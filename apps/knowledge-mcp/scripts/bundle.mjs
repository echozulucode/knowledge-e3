#!/usr/bin/env node
/**
 * Bundle the stdio server into ONE file, `dist/knowledge-mcp.js`.
 *
 * Everything is inlined: the private workspace packages (`@echozedlabs/*`,
 * which are never published) and the public npm dependencies alike, so the
 * published package has no runtime dependencies and `npx` starts it without an
 * install step. The banner supplies the shebang and a CommonJS `require` for
 * the few CJS dependencies (gray-matter and friends) inside an ESM bundle.
 */
import { build } from 'esbuild';
import { chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outfile = join(root, 'dist', 'knowledge-mcp.js');
mkdirSync(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [join(root, 'src', 'bin.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  sourcemap: false,
  legalComments: 'eof',
  metafile: true,
  logLevel: 'warning',
  define: { __KNOWLEDGE_MCP_VERSION__: JSON.stringify(pkg.version) },
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __knowledgeMcpCreateRequire } from 'node:module';",
      'const require = __knowledgeMcpCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});

chmodSync(outfile, 0o755);
const external = Object.keys(result.metafile.inputs).filter((p) => !p.startsWith('node_modules') && !p.includes('/node_modules/') && !p.startsWith('src/') && !p.startsWith('../../packages/'));
const bytes = statSync(outfile).size;
process.stderr.write(`bundled ${outfile} (${(bytes / 1024).toFixed(0)} KiB, ${Object.keys(result.metafile.inputs).length} inputs)\n`);
if (external.length) process.stderr.write(`inputs outside src/packages/node_modules: ${external.join(', ')}\n`);
