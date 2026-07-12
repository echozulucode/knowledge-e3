import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { ValidationPipe } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { AppModule } from '../src/app.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { LARGE_LIBRARY_MARKER, seedLargeLibrary } from './large-library.js';

interface TimingResult {
  name: string;
  thresholdMs: number;
  samples: number[];
  p50: number;
  p95: number;
  max: number;
  passed: boolean;
}

interface ScaleBenchResults {
  timestamp: string;
  config: {
    pages: number;
    seed: number;
    bodyParagraphs: number;
    iterations: number;
  };
  footprint: {
    rssMb: number;
    heapUsedMb: number;
    databaseBytes: number | null;
    databaseLabel: string;
  };
  seed: {
    durationMs: number;
    pages: number;
    topics: number;
    tags: number;
    categories: number;
    groups: number;
  };
  operations: TimingResult[];
  passed: boolean;
  report: string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const pages = intEnv('LARGE_LIBRARY_PAGES', 1_000);
const seed = intEnv('LARGE_LIBRARY_SEED', 67_067);
const bodyParagraphs = intEnv('LARGE_LIBRARY_BODY_PARAGRAPHS', 5);
const iterations = intEnv('LARGE_LIBRARY_ITERATIONS', 5);
const resultsDir = resolve(__dirname, 'results');

const thresholds = {
  initialBrowse: intEnv('LARGE_LIBRARY_INITIAL_BROWSE_MS', 750),
  topicDrawer: intEnv('LARGE_LIBRARY_TOPIC_DRAWER_MS', 500),
  search: intEnv('LARGE_LIBRARY_SEARCH_MS', 650),
  itemOpen: intEnv('LARGE_LIBRARY_ITEM_OPEN_MS', 350),
  create: intEnv('LARGE_LIBRARY_CREATE_MS', 500),
  edit: intEnv('LARGE_LIBRARY_EDIT_MS', 650),
  mcpSearch: intEnv('LARGE_LIBRARY_MCP_SEARCH_MS', 750),
};

async function main() {
  console.log('\n=== Knowledge E3 Large-Library Scale Smoke ===\n');
  console.log(`Pages: ${pages}`);
  console.log(`Seed: ${seed}`);
  console.log(`Body paragraphs per item: ${bodyParagraphs}`);
  console.log(`Iterations per timed operation: ${iterations}`);
  console.log('Database: in-memory SQLite (generated data is not written to git)\n');

  process.env['DB_URL'] = ':memory:';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }));
  await app.init();

  try {
    const auth = app.get(AuthService);
    const user = await auth.createUser({
      email: 'large-library@example.com',
      username: 'scale',
      password: 'scale-password-123',
      role: 'admin',
    });
    const db = app.get<Kysely<Database>>(KYSELY);

    const seedStart = performance.now();
    const seedResult = await seedLargeLibrary(db, user.id, { count: pages, seed, bodyParagraphs });
    const seedMs = performance.now() - seedStart;

    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'scale', password: 'scale-password-123' })
      .expect(200);
    const cookie = extractCookie(loginRes.headers['set-cookie']);
    const firstId = seedResult.firstPageId;
    const markerQuery = encodeURIComponent(LARGE_LIBRARY_MARKER);

    const operations: TimingResult[] = [];
    operations.push(await timeHttp('initial browse /items?limit=50', thresholds.initialBrowse, async () => {
      await request(app.getHttpServer()).get('/api/v1/items?limit=50').set('Cookie', cookie).expect(200);
    }));
    operations.push(await timeHttp('topic drawer /topics', thresholds.topicDrawer, async () => {
      await request(app.getHttpServer()).get('/api/v1/topics').set('Cookie', cookie).expect(200);
    }));
    operations.push(await timeHttp('search broad marker', thresholds.search, async () => {
      await request(app.getHttpServer()).get(`/api/v1/search?q=${markerQuery}&limit=25`).set('Cookie', cookie).expect(200);
    }));
    operations.push(await timeHttp('item open by id', thresholds.itemOpen, async () => {
      await request(app.getHttpServer()).get(`/api/v1/items/${firstId}`).set('Cookie', cookie).expect(200);
    }));
    let createdId = '';
    let versionToken = 0;
    operations.push(await timeHttp('create item', thresholds.create, async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/items')
        .set('Cookie', cookie)
        .send({
          title: `Scale Smoke Created ${Date.now()}`,
          body: `Created during large-library smoke with ${LARGE_LIBRARY_MARKER}.`,
          status: 'draft',
          tags: ['scale-test', 'created-smoke'],
          frontmatter: { topic: 'Product Strategy', categories: ['Experiment'], groups: ['scale-validation'] },
        })
        .expect(201);
      createdId = res.body.item.id;
      versionToken = res.body.item.version_token;
    }));
    operations.push(await timeHttp('edit item', thresholds.edit, async () => {
      await request(app.getHttpServer())
        .put(`/api/v1/items/${createdId}`)
        .set('Cookie', cookie)
        .set('If-Match', String(versionToken))
        .send({ body: `Edited during large-library smoke at ${new Date().toISOString()}.` })
        .expect(200);
      versionToken += 1;
    }));
    operations.push(await timeHttp('MCP knowledge.search', thresholds.mcpSearch, async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/mcp/jsonrpc')
        .set('Cookie', cookie)
        .send({ jsonrpc: '2.0', id: 'scale-search', method: 'tools/call', params: { name: 'knowledge.search', arguments: { q: LARGE_LIBRARY_MARKER, limit: 10 } } })
        .expect(200);
      if (res.body.error) throw new Error(`MCP error: ${JSON.stringify(res.body.error)}`);
      if ((res.body.result?.results?.length ?? 0) < 1) throw new Error('MCP search returned no results');
    }));

    const footprint = await measureFootprint(db);
    const failed = operations.filter((operation) => !operation.passed);
    const results: ScaleBenchResults = {
      timestamp: new Date().toISOString(),
      config: { pages, seed, bodyParagraphs, iterations },
      footprint,
      seed: {
        durationMs: round(seedMs),
        pages: seedResult.pages,
        topics: seedResult.topics,
        tags: seedResult.tags,
        categories: seedResult.categories,
        groups: seedResult.groups,
      },
      operations,
      passed: failed.length === 0,
      report: [
        'Current bottlenecks to watch: broad search result ranking, full item payload size for long bodies, and client render cost in the topic-grouped browse view.',
        'Next tuning candidates: inspect SQLite query plans for taxonomy joins, cap initial browse payloads, lazy-load long body content for cards, and add browser trace budget once the UI benchmark is stable in CI.',
      ],
    };

    mkdirSync(resultsDir, { recursive: true });
    const outputPath = path.join(resultsDir, `large-library-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
    writeFileSync(outputPath, JSON.stringify(results, null, 2));

    console.log('\nOperation timings:');
    console.table(operations.map((operation) => ({
      operation: operation.name,
      p50: `${operation.p50}ms`,
      p95: `${operation.p95}ms`,
      max: `${operation.max}ms`,
      threshold: `${operation.thresholdMs}ms`,
      passed: operation.passed,
    })));
    console.log(`Seeded ${seedResult.pages} items across ${seedResult.topics} topics in ${round(seedMs)}ms`);
    console.log(`Memory RSS: ${footprint.rssMb}MB; heap used: ${footprint.heapUsedMb}MB; DB footprint: ${footprint.databaseLabel}`);
    console.log(`Results written to ${outputPath}`);

    if (failed.length > 0) {
      console.error(`\nFAIL: ${failed.length} large-library operation(s) exceeded thresholds.`);
      process.exitCode = 1;
    } else {
      console.log('\nPASS: large-library server/API/MCP smoke stayed within configured thresholds.');
    }
  } finally {
    await app.close();
  }
}

async function timeHttp(name: string, thresholdMs: number, fn: () => Promise<void>): Promise<TimingResult> {
  const samples: number[] = [];
  await fn(); // warmup
  for (let idx = 0; idx < iterations; idx += 1) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const max = sorted[sorted.length - 1] ?? 0;
  return { name, thresholdMs, samples: samples.map(round), p50: round(p50), p95: round(p95), max: round(max), passed: p95 <= thresholdMs };
}

async function measureFootprint(db: Kysely<Database>): Promise<ScaleBenchResults['footprint']> {
  const mem = process.memoryUsage();
  const pageCount = await sql<{ page_count: number }>`PRAGMA page_count`.execute(db);
  const pageSize = await sql<{ page_size: number }>`PRAGMA page_size`.execute(db);
  const dbBytes = Number(pageCount.rows[0]?.page_count ?? 0) * Number(pageSize.rows[0]?.page_size ?? 0);
  const dbUrl = process.env['DB_URL'];
  let fileBytes: number | null = null;
  if (dbUrl && dbUrl !== ':memory:' && existsSync(dbUrl)) fileBytes = statSync(dbUrl).size;
  const bytes = fileBytes ?? (Number.isFinite(dbBytes) && dbBytes > 0 ? dbBytes : null);
  return {
    rssMb: round(mem.rss / 1024 / 1024),
    heapUsedMb: round(mem.heapUsed / 1024 / 1024),
    databaseBytes: bytes,
    databaseLabel: bytes === null ? 'unknown' : `${round(bytes / 1024 / 1024)}MB`,
  };
}

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * pct) - 1)]!;
}

function extractCookie(setCookie: string[] | string | undefined): string {
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = arr.find((entry) => entry.startsWith('kp_session='));
  if (!cookie) throw new Error('No kp_session cookie returned');
  return cookie.split(';')[0]!;
}

function intEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
