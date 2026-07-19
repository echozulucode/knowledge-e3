/**
 * Performance benchmark script.
 *
 * Bootstraps a NestJS app with in-memory SQLite, seeds N pages, and measures:
 *   1. Search query latencies (p50/p95/p99)
 *   2. Page CRUD micro-benchmarks (create, read, update)
 *   3. Throughput over a fixed 5-second window
 *
 * Outputs: JSON results file + human-readable summary table to stdout.
 *
 * Usage:
 *   pnpm bench                      # defaults to 1000 pages
 *   BENCH_PAGES=100 pnpm bench     # smoke test with 100 pages
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, writeFileSync } from 'fs';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { PagesService } from '../src/pages/pages.service.js';
import { SearchService } from '../src/search/search.service.js';
import { seedPages } from './seed.js';
import { BENCH_QUERIES } from './queries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const NUM_PAGES = parseInt(process.env['BENCH_PAGES'] ?? '1000', 10);
const RESULTS_DIR = path.join(__dirname, 'results');

interface TimingResult {
  name: string;
  times: number[];
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
  throughputOpsPerSec?: number;
}

interface BenchmarkResults {
  timestamp: string;
  config: {
    numPages: number;
    queriesRun: number;
    crudIterations: number;
  };
  search: TimingResult[];
  crudCreate: TimingResult;
  crudRead: TimingResult;
  crudUpdate: TimingResult;
  notes: string;
}

async function main() {
  console.log('\n=== Knowledge E3 Benchmark ===\n');
  console.log(`Configuration:`);
  console.log(`  Pages to seed: ${NUM_PAGES}`);
  console.log(`  Search queries: ${BENCH_QUERIES.length}`);
  console.log(`  Target (spec): p95 < 200ms over 1000 pages\n`);

  // Bootstrap
  console.log('Bootstrapping NestJS app with in-memory SQLite...');
  process.env['DB_URL'] = ':memory:';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }),
  );
  await app.init();
  console.log('✓ App initialized\n');

  try {
    // Create admin user + login
    console.log('Creating admin user...');
    const auth = app.get(AuthService);
    const adminUser = await auth.createUser({
      email: 'bench@example.com',
      username: 'bench',
      password: 'bench-password-123',
      role: 'admin',
    });
    console.log(`✓ Admin user created: ${adminUser.id}\n`);

    // Seed pages
    console.log(`Seeding ${NUM_PAGES} pages...`);
    const pagesService = app.get(PagesService);
    const seedStart = performance.now();
    const seedResult = await seedPages({ db: (app as any).get('Kysely'), userId: adminUser.id, count: NUM_PAGES });
    const seedMs = performance.now() - seedStart;
    console.log(`✓ Seeded ${seedResult.count} pages in ${seedMs.toFixed(1)}ms\n`);

    // Verify page count
    const allPages = await pagesService.list({ limit: 10000 });
    console.log(`✓ Verified: ${allPages.length} pages in database\n`);

    // Login for HTTP requests
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'bench', password: 'bench-password-123' })
      .expect(200);
    const setCookie = loginRes.headers['set-cookie'];
    const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const cookieHeader = arr.find((c: string) => c.startsWith('kp_session='));
    if (!cookieHeader) throw new Error('No session cookie');
    const cookie = cookieHeader.split(';')[0];

    const results: BenchmarkResults = {
      timestamp: new Date().toISOString(),
      config: {
        numPages: NUM_PAGES,
        queriesRun: BENCH_QUERIES.length,
        crudIterations: 100,
      },
      search: [],
      crudCreate: { name: 'create', times: [], p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0 },
      crudRead: { name: 'read', times: [], p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0 },
      crudUpdate: { name: 'update', times: [], p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0 },
      notes: `Benchmark run on in-memory SQLite. Absolute numbers differ from production SQL Server, but relative performance trends should hold. p95 < 200ms is the target per spec §7.4.`,
    };

    // Search queries
    console.log('Running search queries...');
    for (const query of BENCH_QUERIES) {
      const times: number[] = [];
      // Run 3 iterations to warm cache + gather stats
      for (let i = 0; i < 3; i++) {
        const qs = new URLSearchParams();
        if (query.q) qs.append('q', query.q);
        if (query.tag) qs.append('tag', query.tag);
        if (query.sort) qs.append('sort', query.sort);
        const start = performance.now();
        await request(app.getHttpServer())
          .get(`/api/v1/search?${qs.toString()}`)
          .set('Cookie', cookie)
          .expect(200);
        const elapsed = performance.now() - start;
        times.push(elapsed);
      }
      const timing = computeStats(query.name, times);
      results.search.push(timing);
      console.log(`  ✓ ${query.name}: p95=${timing.p95.toFixed(1)}ms`);
    }
    console.log('');

    // CRUD micro-benchmarks
    console.log('Running CRUD micro-benchmarks (100 iterations each)...');

    // CREATE
    console.log('  Creating 100 pages...');
    const createTimes: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      await request(app.getHttpServer())
        .post('/api/v1/pages')
        .set('Cookie', cookie)
        .send({
          title: `Bench Page Create ${i}`,
          body: `Content for page ${i}`,
          status: 'published',
        })
        .expect(200);
      const elapsed = performance.now() - start;
      createTimes.push(elapsed);
    }
    results.crudCreate = computeStats('create', createTimes);
    console.log(`  ✓ Create: p95=${results.crudCreate.p95.toFixed(1)}ms`);

    // READ: fetch a random page 100 times
    console.log('  Reading 100 pages...');
    const readTimes: number[] = [];
    const pageIds = seedResult.ids.slice(0, 100);
    for (const id of pageIds) {
      const start = performance.now();
      await request(app.getHttpServer())
        .get(`/api/v1/pages/${id}`)
        .set('Cookie', cookie)
        .expect(200);
      const elapsed = performance.now() - start;
      readTimes.push(elapsed);
    }
    results.crudRead = computeStats('read', readTimes);
    console.log(`  ✓ Read: p95=${results.crudRead.p95.toFixed(1)}ms`);

    // UPDATE: fetch a page, update its body, write back with If-Match
    console.log('  Updating 100 pages...');
    const updateTimes: number[] = [];
    for (let i = 0; i < 100; i++) {
      const pageId = pageIds[i];
      // GET to get the version token
      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/pages/${pageId}`)
        .set('Cookie', cookie)
        .expect(200);
      const versionToken = getRes.body.page.version_token;
      // PUT with If-Match
      const start = performance.now();
      await request(app.getHttpServer())
        .put(`/api/v1/pages/${pageId}`)
        .set('Cookie', cookie)
        .set('If-Match', String(versionToken))
        .send({
          body: `Updated content at ${new Date().toISOString()}`,
        })
        .expect(200);
      const elapsed = performance.now() - start;
      updateTimes.push(elapsed);
    }
    results.crudUpdate = computeStats('update', updateTimes);
    console.log(`  ✓ Update: p95=${results.crudUpdate.p95.toFixed(1)}ms\n`);

    // Compute throughput for search (fixed 5-second window, single-threaded)
    // Rough estimate: run one search 20 times in a loop and measure total time
    const warmupStart = performance.now();
    for (let i = 0; i < 20; i++) {
      await request(app.getHttpServer())
        .get('/api/v1/search?q=retry')
        .set('Cookie', cookie)
        .expect(200);
    }
    const throughputMs = performance.now() - warmupStart;
    const searchThroughputOpsPerSec = (20 / (throughputMs / 1000)).toFixed(2);
    results.search[0]!.throughputOpsPerSec = parseFloat(searchThroughputOpsPerSec);

    // Write results
    mkdirSync(RESULTS_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filePath = path.join(RESULTS_DIR, `${timestamp}.json`);
    writeFileSync(filePath, JSON.stringify(results, null, 2));
    console.log(`✓ Results written to: ${filePath}\n`);

    // Summary table
    console.log('=== Summary ===\n');
    console.log('Search Queries:');
    const searchTable = results.search.map((r) => ({
      query: r.name,
      'p50 (ms)': r.p50.toFixed(1),
      'p95 (ms)': r.p95.toFixed(1),
      'p99 (ms)': r.p99.toFixed(1),
    }));
    console.table(searchTable);

    console.log('\nCRUD Micro-benchmarks:');
    const crudTable = [results.crudCreate, results.crudRead, results.crudUpdate].map((r) => ({
      operation: r.name,
      'p50 (ms)': r.p50.toFixed(1),
      'p95 (ms)': r.p95.toFixed(1),
      'p99 (ms)': r.p99.toFixed(1),
    }));
    console.table(crudTable);

    console.log(`\nEstimated search throughput: ~${searchThroughputOpsPerSec} ops/sec (single-threaded)\n`);

    const maxP95 = Math.max(
      ...results.search.map((r) => r.p95),
      results.crudCreate.p95,
      results.crudRead.p95,
      results.crudUpdate.p95,
    );
    console.log(`Max p95 across all operations: ${maxP95.toFixed(1)}ms`);
    console.log(`Spec target (search, 1000 pages): p95 < 200ms`);
    if (maxP95 < 200) {
      console.log('✓ PASS: Meets specification\n');
    } else {
      console.log(`⚠ FAIL: Exceeds specification target by ${(maxP95 - 200).toFixed(1)}ms\n`);
    }
  } finally {
    await app.close();
  }
}

function computeStats(name: string, times: number[]): TimingResult {
  if (times.length === 0) {
    return { name, times: [], p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0 };
  }
  const sorted = [...times].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  return { name, times, p50, p95, p99, mean, min, max };
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
