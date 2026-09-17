/**
 * Emit the server's OpenAPI document to server/openapi.json.
 *
 *   pnpm --filter @echozedlabs/server openapi
 *
 * Boots the real AppModule in-process against an in-memory SQLite database
 * (the same wiring the e2e harness uses) so the document reflects the routes
 * that actually ship. NODE_ENV=test keeps the git revision mirror off — the
 * script never touches a repository. The output is key-sorted so regenerating
 * it yields a stable diff; `@echozedlabs/api-client` generates its types from it.
 */
import 'reflect-metadata';
process.env['DB_URL'] = ':memory:';
process.env['NODE_ENV'] = 'test';

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';

const OUT = resolve(process.cwd(), 'openapi.json');

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app, { webDist: null });
  await app.init();
  try {
    const config = new DocumentBuilder()
      .setTitle('Knowledge E3 API')
      .setVersion('v1')
      .addServer('/api/v1')
      .build();
    // Paths stay relative to the `servers` entry rather than repeating the
    // global prefix on every route.
    const document = SwaggerModule.createDocument(app, config, { ignoreGlobalPrefix: true });
    writeFileSync(OUT, `${JSON.stringify(sortKeys(document), null, 2)}\n`);
    // eslint-disable-next-line no-console
    console.log(`[openapi] wrote ${Object.keys(document.paths).length} paths to ${OUT}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[openapi] failed:', err);
  process.exit(1);
});
