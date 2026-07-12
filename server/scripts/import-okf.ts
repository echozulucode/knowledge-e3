/**
 * Import an Open Knowledge Format (OKF) bundle directory into Knowledge E3.
 *
 * The reverse of export:okf. Concepts are matched to existing items by their
 * embedded e3_id (then exact title), so re-importing updates rather than
 * duplicates. Runs through the real services (taxonomy sync, wiki indexing,
 * audit) via a Nest application context.
 *
 *   pnpm --filter @echozedlabs/server import:okf ./data/okf-export
 *   DB_URL=./data/kp.sqlite pnpm --filter @echozedlabs/server import:okf ./data/okf-export
 */
import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { OkfImportService } from '../src/okf/okf-import.service.js';

const args = process.argv.slice(2);
const inArg = args.find((a) => !a.startsWith('--')) ?? process.env['OKF_IN'] ?? './data/okf-export';

function readBundle(rootDir: string): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  for (const entry of readdirSync(rootDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const abs = join(entry.parentPath ?? rootDir, entry.name);
    const rel = relative(rootDir, abs).split('\\').join('/');
    files.push({ path: rel, content: readFileSync(abs, 'utf8') });
  }
  return files;
}

async function main(): Promise<void> {
  const inDir = isAbsolute(inArg) ? inArg : resolve(process.cwd(), inArg);
  // eslint-disable-next-line no-console
  console.log(`[okf] importing from ${inDir}`);

  const ctx = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const auth = ctx.get(AuthService);
    const importer = ctx.get(OkfImportService);
    const system = await auth.ensureLocalSystemActor();
    const actor = { id: system.id, role: system.role === 'admin' ? ('admin' as const) : ('user' as const) };

    const files = readBundle(inDir);
    const result = await importer.importBundleFiles(actor, files);
    // eslint-disable-next-line no-console
    console.log(`[okf] import done: ${result.created} created, ${result.updated} updated.`);
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[okf] import failed:', err);
  process.exit(1);
});
