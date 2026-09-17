/**
 * The first-run admin bootstrap, as ONE implementation with two callers.
 *
 * A fresh instance boots with an empty `users` table and authentication that
 * cannot be turned off (`auth-mode.ts`), so it has a login wall and no account
 * behind it. This is the one thing that closes that gap, and it is shared by:
 *
 *   - `src/seed.ts` — the developer seed (admin **plus** the demo corpus).
 *   - `scripts/seed-admin.mjs` — the container entrypoint's bootstrap
 *     (admin ONLY; a real self-host does not want 100 demo items).
 *
 * It deliberately does NOT go through `AuthService.createUser`, and the reason
 * is ordering rather than taste: the bootstrap runs before the process that
 * would host a Nest context exists, and before migrations on a first boot, so
 * there is no injector and no `app_config` table to read yet. What it DOES do
 * is keep the semantics of that path identical — the same username/email
 * collision rule, the same admin-configurable password policy, the same
 * `hashPassword` — so the account this creates is indistinguishable from one an
 * admin creates in the Users console.
 *
 * The password is never logged, never returned, and never put in an error
 * message; only the username and email are ever printed.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { DEFAULT_PASSWORD_POLICY, PASSWORD_POLICY_KEY, validatePassword, type PasswordPolicy } from '../config/config.service.js';
import { hashPassword } from './password.js';
import { newId, nowIso } from '../common/ids.js';

export interface AdminCredentials {
  username: string;
  email: string;
  password: string;
}

export interface SeedAdminResult {
  id: string;
  /** False when the account already existed — the idempotent no-op. */
  created: boolean;
}

/**
 * Credentials from `SEED_ADMIN_USERNAME` / `SEED_ADMIN_EMAIL` /
 * `SEED_ADMIN_PASSWORD`, or null when no password is available.
 *
 * `defaultPassword` exists for the developer seed only, which has always had a
 * documented local password. The self-host bootstrap passes nothing and gets
 * null, because a well-known default password on an instance someone may expose
 * to a network is the failure this whole file is meant to prevent.
 */
export function adminCredentialsFromEnv(defaultPassword?: string): AdminCredentials | null {
  const password = process.env['SEED_ADMIN_PASSWORD'] || defaultPassword;
  if (!password) return null;
  return {
    username: process.env['SEED_ADMIN_USERNAME'] ?? 'admin',
    email: process.env['SEED_ADMIN_EMAIL'] ?? 'admin@local',
    password,
  };
}

/** The live policy: admin-set values (Admin → Authentication) over the built-in defaults. */
export async function passwordPolicy(db: Kysely<Database>): Promise<PasswordPolicy> {
  const row = await db.selectFrom('app_config').select(['value_json']).where('key', '=', PASSWORD_POLICY_KEY).executeTakeFirst();
  if (!row) return DEFAULT_PASSWORD_POLICY;
  try {
    return { ...DEFAULT_PASSWORD_POLICY, ...(JSON.parse(row.value_json) as Partial<PasswordPolicy>) };
  } catch {
    return DEFAULT_PASSWORD_POLICY;
  }
}

/**
 * Create the admin if it is not already there. Returns its id either way.
 *
 * Idempotent on BOTH unique fields, like `AuthService.createUser`: an existing
 * row matching the username or the email is the no-op, because re-running with
 * a changed `SEED_ADMIN_USERNAME` against the same `SEED_ADMIN_EMAIL` would
 * otherwise fail on the email index rather than quietly doing nothing.
 *
 * It never updates an existing account, and in particular never resets its
 * password: the entrypoint runs this on every boot, and a bootstrap that
 * rewrote the password would silently undo the admin's own change.
 */
export async function seedAdmin(db: Kysely<Database>, credentials: AdminCredentials, log: (message: string) => void): Promise<SeedAdminResult> {
  const { username, email, password } = credentials;
  const existing = await db
    .selectFrom('users')
    .select(['id', 'username', 'role'])
    .where((eb) => eb.or([eb('username', '=', username), eb('email', '=', email)]))
    .executeTakeFirst();
  if (existing) {
    log(`user '${existing.username}' already exists (role=${existing.role}); no-op.`);
    return { id: existing.id, created: false };
  }

  const failures = validatePassword(await passwordPolicy(db), password);
  if (failures.length > 0) {
    // Names the rule, never the password.
    throw new Error(`SEED_ADMIN_PASSWORD must ${failures.join(', ')}.`);
  }

  const id = newId();
  await db
    .insertInto('users')
    .values({
      id,
      email,
      username,
      password_hash: await hashPassword(password),
      role: 'admin',
      created_at: nowIso(),
      deleted_at: null,
    })
    .execute();
  log(`created admin '${username}' (email='${email}'). Sign in at /login.`);
  return { id, created: true };
}
