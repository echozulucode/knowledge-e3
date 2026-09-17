import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';

export async function makeApp(): Promise<INestApplication> {
  // Each test gets a fresh in-memory SQLite database via a unique DB_URL.
  process.env['DB_URL'] = ':memory:';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  // Use the SAME wiring the server ships (parsers, /assets mapping, prefix,
  // validation) rather than re-declaring it here — a hand-maintained copy of
  // this stack is what hid the production /assets 404 from these very tests.
  // SPA serving is off: tests exercise the API, not the built client.
  configureApp(app, { webDist: null });
  await app.init();
  return app;
}

export async function seedAdminAndLogin(
  app: INestApplication,
  username = 'admin',
  password = 'admin-password-123',
): Promise<{ cookie: string; userId: string }> {
  const auth = app.get(AuthService);
  const user = await auth.createUser({
    email: `${username}@example.com`,
    username,
    password,
    role: 'admin',
  });
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ username, password })
    .expect(200);
  const setCookie = res.headers['set-cookie'];
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookieHeader = arr.find((c: string) => c.startsWith('kp_session='));
  if (!cookieHeader) throw new Error('No session cookie returned');
  return { cookie: cookieHeader.split(';')[0]!, userId: user.id };
}

export async function seedUserAndLogin(
  app: INestApplication,
  username = 'alice',
  password = 'alice-password-123',
): Promise<{ cookie: string; userId: string }> {
  const auth = app.get(AuthService);
  const user = await auth.createUser({
    email: `${username}@example.com`,
    username,
    password,
    role: 'user',
  });
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ username, password })
    .expect(200);
  const setCookie = res.headers['set-cookie'];
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookieHeader = arr.find((c: string) => c.startsWith('kp_session='));
  if (!cookieHeader) throw new Error('No session cookie returned');
  return { cookie: cookieHeader.split(';')[0]!, userId: user.id };
}

/**
 * The curated primary category conformant fixtures file themselves under.
 *
 * Publishing is gated from every interactive door, including a create that
 * lands published in one call (issue 98): an item needs a `type`, a
 * `description` and exactly one primary category from the CURATED catalog, or
 * the write is refused with 422 `lint_failed`. A fixture that publishes has to
 * be a document that could be published, so it says so explicitly rather than
 * the gate being relaxed for tests.
 */
export const FIXTURE_CATEGORY = 'fixtures';

/**
 * Put categories in the curated catalog (`FIXTURE_CATEGORY` always, plus any
 * named), the way an admin would before anyone may publish into them.
 * Idempotent. Opt-in per suite rather than done by `makeApp`, because a catalog
 * row every test did not ask for would change what the taxonomy suites see.
 */
export async function curateCategories(app: INestApplication, ...slugs: string[]): Promise<void> {
  const db = app.get<Kysely<Database>>(KYSELY);
  const now = new Date().toISOString();
  for (const slug of new Set([FIXTURE_CATEGORY, ...slugs])) {
    await db
      .insertInto('primary_categories')
      .values({ slug, name: slug, created_at: now, updated_at: now, archived_at: null })
      .onConflict((oc) => oc.column('slug').doNothing())
      .execute();
  }
}

/**
 * The minimum frontmatter the publish-time lint asks for, with the caller's
 * own keys winning. A caller that names its own `categories` must curate them
 * (`curateCategories`); one that does not gets `FIXTURE_CATEGORY`.
 */
export function conformant(frontmatter: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'Concept',
    description: 'A test fixture that satisfies the publish-time rules.',
    categories: [FIXTURE_CATEGORY],
    ...frontmatter,
  };
}

/** `conformant()` as YAML lines, for a fixture written as a raw document. */
export const CONFORMANT_YAML = `type: Concept\ndescription: A test fixture that satisfies the publish-time rules.\ncategories: [${FIXTURE_CATEGORY}]\n`;
