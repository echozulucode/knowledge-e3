/**
 * First-run admin bootstrap for the self-hosted image — admin ONLY, no demo data.
 *
 * A fresh container boots with an empty database, and authentication cannot be
 * turned off (`server/src/auth/auth-mode.ts`), so without this there is a login
 * wall and no account behind it. The entrypoint runs this on every boot; it is a
 * no-op once the admin exists.
 *
 *   node scripts/seed-admin.mjs        # from the image's /app working directory
 *
 * Unlike `server/dist/seed.js` (which also loads the demo corpus), this seeds
 * only the admin, which is what a real self-host wants. It is a thin wrapper:
 * the account is created by the server's own `seedAdmin`, so the schema, the
 * password policy and the hashing stay identical to the app rather than drifting
 * in a copy. Plain `.mjs` against `server/dist` because the image has no
 * TypeScript loader at runtime.
 *
 * Environment:
 *   SEED_ADMIN_PASSWORD  required; without it this exits 0 having done nothing
 *   SEED_ADMIN_USERNAME  default `admin`
 *   SEED_ADMIN_EMAIL     default `admin@local`
 *   DB_URL               default `/data/kp.sqlite` (the image's default)
 *
 * The password is never printed, here or in a failure.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeKysely } from '../server/dist/db/db.module.js';
import { migrateSqlite } from '../server/dist/db/migrations.js';
import { adminCredentialsFromEnv, seedAdmin } from '../server/dist/auth/seed-admin.js';

const log = (message) => console.log(`[seed-admin] ${message}`);

// No fallback password on purpose: a well-known default on an instance someone
// may put on a network is worse than no admin at all.
const credentials = adminCredentialsFromEnv();
if (!credentials) {
  log('SEED_ADMIN_PASSWORD not set — skipping the first-run admin bootstrap.');
  process.exit(0);
}

// `makeKysely` takes the path as given; the server's own boot path is what
// normally creates the directory, and this runs before it.
const dbUrl = process.env.DB_URL ?? '/data/kp.sqlite';
if (dbUrl !== ':memory:') mkdirSync(dirname(dbUrl), { recursive: true });

const db = makeKysely({ url: dbUrl, driver: 'sqlite' });
try {
  // The bootstrap runs before the server, so on a first boot it is also what
  // creates the schema. Idempotent (`ifNotExists` DDL), as the server's own
  // boot-time call is.
  await migrateSqlite(db);
  await seedAdmin(db, credentials, log);
} catch (err) {
  // The message, not the stack: this is the first thing an operator sees in
  // `docker compose logs`, and a rejected password should read as one line of
  // instruction rather than a crash. Exit 1 so the entrypoint's `||` fires.
  log(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await db.destroy();
}
