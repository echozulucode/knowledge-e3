import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Module, Global, type OnModuleDestroy } from '@nestjs/common';
import { Kysely, SqliteDialect } from 'kysely';
import { NodeSqliteAdapter } from './node-sqlite-adapter.js';
import type { Database as DBSchema } from './schema.js';
import { migrateSqlite } from './migrations.js';
import { loadServerConfig } from '../config/server-config.js';

export const KYSELY = Symbol('KYSELY');

/**
 * Resolve the DB URL with sensible per-environment defaults so the dev loop
 * doesn't require an env-var dance.
 *
 *   - Tests (NODE_ENV=test): always `:memory:` for isolation. Helpers in
 *     server/tests already set this explicitly; we honour their override.
 *   - Production: must set DB_URL explicitly. We don't invent a path.
 *   - Anything else (dev, default): `./data/kp.sqlite`, with the parent dir
 *     auto-created so a fresh checkout just works.
 */
function resolveDbUrl(): string {
  const fromEnv = process.env['DB_URL'];
  if (fromEnv) return fromEnv;
  if (process.env['NODE_ENV'] === 'test') return ':memory:';
  // A config-file `database.url` is honored next (works in production too).
  const fromConfig = loadServerConfig().database.url;
  if (!fromConfig && process.env['NODE_ENV'] === 'production') {
    throw new Error('DB_URL (or database.url in the config file) must be set in production');
  }
  const path = fromConfig ?? './data/kp.sqlite';
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  mkdirSync(dirname(abs), { recursive: true });
  return abs;
}

export interface DbConfig {
  /** SQLite file path or ':memory:'. SQL Server connection string for prod. */
  url: string;
  /** Driver — only 'sqlite' is wired in v0.1; mssql lands when prod stand-up happens. */
  driver: 'sqlite';
}

export function makeKysely(cfg: DbConfig): Kysely<DBSchema> {
  if (cfg.driver !== 'sqlite') {
    throw new Error(`db driver ${cfg.driver} not implemented in v0.1`);
  }
  const sqlite = new NodeSqliteAdapter(cfg.url);
  return new Kysely<DBSchema>({
    dialect: new SqliteDialect({ database: sqlite as unknown as never }),
  });
}

@Global()
@Module({
  providers: [
    {
      provide: KYSELY,
      useFactory: async () => {
        const url = resolveDbUrl();
        const db = makeKysely({ url, driver: 'sqlite' });
        await migrateSqlite(db);
        return db;
      },
    },
  ],
  exports: [KYSELY],
})
export class DbModule implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    // Connections close when the process exits; nothing per-instance to do.
  }
}
