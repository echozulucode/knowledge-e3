/**
 * Adapter wrapping node:sqlite (built into Node 22.5+) to satisfy Kysely's
 * SqliteDialect interface (which is shaped after better-sqlite3).
 *
 * v0.1 ships with this for dev/test (no native compile required). Production
 * SQL Server uses Kysely's MssqlDialect; the application code is identical.
 */
// node:sqlite is experimental, so Node 24 reports it in `builtinModules` only
// with the `node:` prefix. vite-node strips that prefix before its builtin
// lookup, so a static `import 'node:sqlite'` gets resolved as a regular
// package (and fails). Loading via createRequire bypasses Vite entirely.
import { createRequire } from 'node:module';
// `DatabaseSync` and `StatementSync` are imported only for their instance
// types here. Both classes have private constructors, so the runtime ctor is
// loaded via createRequire below — that also bypasses Vite's resolver, which
// strips the `node:` prefix and would otherwise look for an npm package
// called "sqlite" (vite-node bug for newer Node-only builtins).
import type { DatabaseSync, StatementSync, SQLInputValue } from 'node:sqlite';

const nodeRequire = createRequire(import.meta.url);
const sqliteRuntime = nodeRequire('node:sqlite') as {
  DatabaseSync: new (filename: string) => DatabaseSync;
};
const DatabaseSyncCtor = sqliteRuntime.DatabaseSync;

export interface SqliteDatabaseLike {
  close(): void;
  prepare(sql: string): SqliteStatementLike;
}

export interface SqliteStatementLike {
  readonly reader: boolean;
  all(parameters: ReadonlyArray<unknown>): unknown[];
  run(parameters: ReadonlyArray<unknown>): { changes: number | bigint; lastInsertRowid: number | bigint };
  iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown>;
}

export class NodeSqliteAdapter implements SqliteDatabaseLike {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSyncCtor(filename);
    // Journal mode is configurable. WAL is best on a local disk (default), but it
    // does NOT work on network file systems (Azure Files / SMB, NFS) because the
    // WAL shared-memory index is unsupported there — you get "disk I/O error" /
    // "database is locked". Set SQLITE_JOURNAL_MODE=DELETE for SMB-mounted storage.
    const requested = (process.env['SQLITE_JOURNAL_MODE'] ?? 'WAL').toUpperCase();
    const allowed = ['WAL', 'DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY', 'OFF'];
    const journalMode = allowed.includes(requested) ? requested : 'WAL';
    this.db.exec(`PRAGMA journal_mode = ${journalMode}`);
    this.db.exec('PRAGMA foreign_keys = ON');
    // Wait for a briefly-held lock instead of failing instantly (helps on slower FS).
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  prepare(sql: string): SqliteStatementLike {
    return new NodeSqliteStatement(this.db.prepare(sql), sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

class NodeSqliteStatement implements SqliteStatementLike {
  readonly reader: boolean;

  constructor(private readonly stmt: StatementSync, sql: string) {
    // Match better-sqlite3's heuristic: SELECT/WITH/PRAGMA queries are readers.
    this.reader = /^\s*(select|with|pragma|values)\b/i.test(sql);
  }

  all(parameters: ReadonlyArray<unknown>): unknown[] {
    return this.stmt.all(...(parameters as SQLInputValue[])) as unknown[];
  }

  run(parameters: ReadonlyArray<unknown>): { changes: number | bigint; lastInsertRowid: number | bigint } {
    const r = this.stmt.run(...(parameters as SQLInputValue[]));
    return {
      changes: r.changes,
      lastInsertRowid: r.lastInsertRowid,
    };
  }

  iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown> {
    // node:sqlite has no streaming .iterate, so this materializes the ENTIRE
    // result set via .all() and returns an iterator over it — there is no
    // memory win over a plain query (issue P3-7). Callers that could return
    // very large result sets must paginate with LIMIT/OFFSET rather than rely
    // on lazy iteration here.
    const rows = this.stmt.all(...(parameters as SQLInputValue[])) as unknown[];
    return rows[Symbol.iterator]();
  }
}
