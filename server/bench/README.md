# Knowledge E3 Benchmark

Performance benchmark suite.

## Quick Start

```bash
pnpm --filter @echozedlabs/server bench
```

This runs the default benchmark with **1000 pages**.

For a faster smoke test with 100 pages:

```bash
BENCH_PAGES=100 pnpm --filter @echozedlabs/server bench
```

## What It Measures

### 1. Search Query Latencies

Runs 12 representative search queries:

- **single-word**: Simple token match (e.g., "retry").
- **two-word**: Multi-word FTS (e.g., "database index").
- **common-term**: High-recall query (e.g., "the").
- **rare-term**: Low-recall query (e.g., "kubernetes").
- **with-tag-filter**: FTS + tag filter combined.
- **sort-newest**: Recency sort (override relevance).
- **sort-oldest**: Reverse chronological.
- **sort-az**: Alphabetical by title.
- **empty-query-list-all**: List all pages (no FTS).
- **single-word-many-results**: High-volume result set.
- **phrase-like**: Long multi-word query.
- **tag-only-filter**: Filter by tag only (no FTS).

Each query runs **3 iterations** to warm the cache. Reports p50, p95, p99 latencies.

### 2. CRUD Micro-benchmarks

- **Create**: Insert 100 new pages via `POST /pages`.
- **Read**: Fetch 100 pages via `GET /pages/:id`.
- **Update**: Modify 100 pages via `PUT /pages/:id` with optimistic concurrency (`If-Match`).

Reports p50, p95, p99 latencies for each.

### 3. Throughput

Single-threaded throughput estimate for a typical search query over a fixed time window.

## Output

Results are written to `server/bench/results/<timestamp>.json` with:

- Configuration (page count, query count, CRUD iterations).
- Per-query latency statistics (p50, p95, p99, mean, min, max).
- CRUD operation statistics.
- Throughput estimate.

A human-readable summary table is also printed to stdout.

## Specification Target

Per **v0.1 specification §7.4**:

> Full-text search across 1000 pages returns **p95 < 200 ms**.

The benchmark verifies this target over the full query suite. Absolute numbers will differ between in-memory SQLite (used in the benchmark) and production SQL Server, but the relative performance trends should hold.

## Important Notes on SQLite vs SQL Server

### SQLite (Benchmark)

- In-memory database (`:memory:`).
- No disk I/O, no network latency.
- Single-threaded, cooperative concurrency.
- FTS5 with BM25 scoring.
- **Optimistic**: Latencies will be faster than production.

### SQL Server (Production)

- Persistent storage on disk.
- Network latency to database.
- Optimized query planner for complex joins.
- CONTAINSTABLE (SQL Server FTS) with configurable ranking.
- **Realistic**: Absolute latencies will be higher, but scalability characteristics should be similar.

### Interpretation

1. **In-benchmark results much faster than p95 < 200ms?** ✓ Good sign. SQLite overhead is minimal; SQL Server's network latency will dominate in production.
2. **In-benchmark results violate p95 < 200ms?** ⚠ Red flag. Either the query plan is pathological, or the index strategy needs tuning.
3. **Results degrade significantly with page count?** Measure at 100, 1000, 10000 pages to see the trend. If p95 scales linearly with log(page_count), the index is working well.

## Files

- `run.ts` — Main benchmark orchestrator.
- `seed.ts` — Page seeding utility. Reused for ad-hoc population of local DBs.
- `queries.ts` — Static list of representative search queries.
- `results/` — Output directory for JSON result files (created on first run).

## Future Improvements

- Parameterize query complexity (number of tokens, filter combinations).
- Add distributed/concurrent load simulation (currently single-threaded).
- Compare cold-start (first query) vs warm-cache latencies.
- Profile SQL Server execution plans using extended events or Query Store.
