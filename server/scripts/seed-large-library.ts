import { statSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import { sql, type Kysely } from 'kysely';
import { AppModule } from '../src/app.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { seedLargeLibrary } from '../bench/large-library.js';

const count = intEnv('LARGE_LIBRARY_PAGES', 1_000);
const seed = intEnv('LARGE_LIBRARY_SEED', 67_067);
const bodyParagraphs = intEnv('LARGE_LIBRARY_BODY_PARAGRAPHS', 5);

async function main() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  try {
    const auth = app.get(AuthService);
    const actor = await auth.ensureLocalSystemActor();
    const db = app.get<Kysely<Database>>(KYSELY);
    const started = performance.now();
    const result = await seedLargeLibrary(db, actor.id, { count, seed, bodyParagraphs });
    const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
    const dbStats = await measureDatabase(db);
    console.log(JSON.stringify({ ...result, elapsedMs, ...dbStats }, null, 2));
  } finally {
    await app.close();
  }
}

async function measureDatabase(db: Kysely<Database>) {
  const pageCount = await sql<{ page_count: number }>`PRAGMA page_count`.execute(db);
  const pageSize = await sql<{ page_size: number }>`PRAGMA page_size`.execute(db);
  const estimatedBytes = Number(pageCount.rows[0]?.page_count ?? 0) * Number(pageSize.rows[0]?.page_size ?? 0);
  const dbUrl = process.env['DB_URL'];
  const fileBytes = dbUrl && dbUrl !== ':memory:' ? safeStatSize(dbUrl) : null;
  return {
    databaseBytes: fileBytes ?? estimatedBytes,
    databaseMb: Math.round(((fileBytes ?? estimatedBytes) / 1024 / 1024) * 10) / 10,
  };
}

function safeStatSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function intEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
