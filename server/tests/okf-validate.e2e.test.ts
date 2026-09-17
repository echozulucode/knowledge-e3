/**
 * `POST /okf/validate` and `POST /okf/validate/archive` — the HTTP dry run for the
 * two import doors (the admin UX plan A3).
 *
 * Two properties matter and each has its own test. First, the report is the
 * gate's: the same tiers and verdicts the import would act on, for a bundle that
 * would import, one that would import flagged, and one that would be refused.
 * Second, and more easily broken, the dry run is DRY. "No item was created" is
 * not enough — a validate that recorded policy diagnostics, wrote an audit row,
 * extracted an archive under the content root or nudged the git mirror would
 * pass that check. So the no-write test snapshots every table's row count, every
 * file under the content and asset roots, and every repository's commit count,
 * and proves the snapshot can see a write by importing once first.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import request from 'supertest';
import { sql, type Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { REVISION_MIRROR, type RevisionMirrorPort } from '../src/storage/revision-mirror.port.js';
import { createTarGz } from '../src/okf/tar.js';

interface BundleFile {
  path: string;
  content: string;
}

function slug(title: string): string {
  return title.toLowerCase().replace(/\s+/g, '-');
}

/** Conformant and policy-clean: typed, one primary category, a description. */
function goodConcept(title: string, body = `Body of ${title}.`): BundleFile {
  return {
    path: `concepts/${slug(title)}.md`,
    content: [
      '---',
      'type: Knowledge Page',
      `title: ${title}`,
      'description: A well-formed concept used by the validate tests.',
      'categories:',
      '  - Reference',
      'e3_status: published',
      '---',
      '',
      body,
      '',
    ].join('\n'),
  };
}

/** Conformant OKF, below this instance's standards (no category, no description). */
function belowStandardConcept(title: string): BundleFile {
  return {
    path: `concepts/${slug(title)}.md`,
    content: ['---', 'type: Knowledge Page', `title: ${title}`, 'e3_status: published', '---', '', 'Body.', ''].join('\n'),
  };
}

/** Not OKF: no `type`, a `critical` conformance issue. */
function untypedConcept(title: string): BundleFile {
  return {
    path: `concepts/${slug(title)}.md`,
    content: ['---', `title: ${title}`, 'description: Not a concept.', 'categories:', '  - Reference', '---', '', 'Body.', ''].join('\n'),
  };
}

// A tiny valid 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** Every regular file under `root` (including `.git`) as path → content hash. */
function fileListing(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        out[relative(root, abs).replace(/\\/g, '/')] = createHash('sha256').update(readFileSync(abs)).digest('hex');
      }
    }
  };
  walk(root);
  return out;
}

/** Commit count of every repository under `root` (a dir holding a `.git`). */
function commitCounts(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some((e) => e.name === '.git')) {
      const count = execFileSync('git', ['rev-list', '--count', '--all'], { cwd: dir, encoding: 'utf8' }).trim();
      out[relative(root, dir).replace(/\\/g, '/') || '.'] = Number(count);
    }
    for (const entry of entries) if (entry.isDirectory() && entry.name !== '.git') walk(join(dir, entry.name));
  };
  walk(root);
  return out;
}

describe('OKF validate (dry run) e2e', () => {
  let app: INestApplication;
  let cookie: string;
  let db: Kysely<Database>;
  let contentRoot: string;
  let assetsDir: string;

  beforeEach(async () => {
    // A real content root with the git mirror ON and a short commit debounce, so
    // "nothing was committed" is a statement about a mirror that would have.
    contentRoot = mkdtempSync(join(tmpdir(), 'e3-okf-validate-root-'));
    assetsDir = mkdtempSync(join(tmpdir(), 'e3-okf-validate-assets-'));
    process.env['GIT_MIRROR_ROOT'] = contentRoot;
    process.env['GIT_COMMIT_QUIET_MS'] = '20';
    process.env['GIT_COMMIT_MAX_MS'] = '50';
    process.env['KNOWLEDGE_E3_ASSETS_DIR'] = assetsDir;
    app = await makeApp();
    ({ cookie } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
  });

  afterEach(async () => {
    await app.close();
    delete process.env['GIT_MIRROR_ROOT'];
    delete process.env['GIT_COMMIT_QUIET_MS'];
    delete process.env['GIT_COMMIT_MAX_MS'];
    delete process.env['KNOWLEDGE_E3_ASSETS_DIR'];
    rmSync(contentRoot, { recursive: true, force: true });
    rmSync(assetsDir, { recursive: true, force: true });
  });

  const validate = (files: unknown, sessionCookie: string | null = cookie) => {
    const req = request(app.getHttpServer()).post('/api/v1/okf/validate');
    if (sessionCookie) req.set('Cookie', sessionCookie);
    return req.send({ files });
  };

  const validateArchive = (archive: Buffer, sessionCookie: string | null = cookie) => {
    const req = request(app.getHttpServer()).post('/api/v1/okf/validate/archive').set('Content-Type', 'application/gzip');
    if (sessionCookie) req.set('Cookie', sessionCookie);
    return req.send(archive);
  };

  async function tableCounts(): Promise<Record<string, number>> {
    const tables = await sql<{ name: string }>`
      select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name
    `.execute(db);
    const out: Record<string, number> = {};
    for (const { name } of tables.rows) {
      const row = await sql<{ n: number }>`select count(*) as n from ${sql.table(name)}`.execute(db);
      out[name] = Number(row.rows[0]!.n);
    }
    return out;
  }

  async function snapshot() {
    await app.get<RevisionMirrorPort>(REVISION_MIRROR).flush?.();
    return {
      tables: await tableCounts(),
      content: fileListing(contentRoot),
      assets: fileListing(assetsDir),
      commits: commitCounts(contentRoot),
    };
  }

  it('returns the gate report for a bundle that would import cleanly', async () => {
    const res = await validate([goodConcept('Validate Orders'), goodConcept('Validate Customers')]).expect(200);

    expect(res.body).toMatchObject({ conformance: expect.any(Array), policy: expect.any(Array), advisory: expect.any(Array) });
    expect(res.body.summary).toMatchObject({ conformant: true, meetsPolicy: true, conceptCount: 2, criticalCount: 0 });
    expect(res.body.summary_line).toContain('meets policy');
  });

  it('returns 200 with the refusal named per file and rule for a bundle the import would refuse', async () => {
    const res = await validate([goodConcept('Validate Sibling'), untypedConcept('Validate Untyped')]).expect(200);

    expect(res.body.summary.conformant).toBe(false);
    expect(res.body.summary.criticalCount).toBe(1);
    const critical = res.body.conformance.find((i: { code: string }) => i.code === 'type.missing');
    expect(critical).toMatchObject({ path: 'concepts/validate-untyped.md', severity: 'critical', message: expect.any(String) });
    expect(res.body.summary_line).toContain('refused');

    // And the import agrees with its preview: the same bundle is refused.
    await request(app.getHttpServer())
      .post('/api/v1/okf/import')
      .set('Cookie', cookie)
      .send({ files: [goodConcept('Validate Sibling'), untypedConcept('Validate Untyped')] })
      .expect(422);
  });

  it('reports policy findings as non-blocking: conformant, below standard', async () => {
    const res = await validate([belowStandardConcept('Validate Flagged')]).expect(200);

    expect(res.body.summary).toMatchObject({ conformant: true, meetsPolicy: false });
    expect(res.body.policy.map((i: { code: string }) => i.code)).toEqual(
      expect.arrayContaining(['category.missing', 'description.missing']),
    );
    expect(res.body.summary_line).toContain('ACCEPTED');
  });

  it('validates a .tar.gz archive in memory with the import’s own extraction', async () => {
    const archive = createTarGz([
      goodConcept('Archive Good'),
      untypedConcept('Archive Untyped'),
      { path: 'assets/diagram.png', content: PNG },
      { path: 'assets/diagram.png.meta.json', content: JSON.stringify({ mime: 'image/png' }) },
    ]);

    const res = await validateArchive(archive).expect(200);
    expect(res.body.summary).toMatchObject({ conformant: false, conceptCount: 2, criticalCount: 1 });
    expect(res.body.conformance.map((i: { path: string }) => i.path)).toContain('concepts/archive-untyped.md');
    expect(res.body.assets).toBe(1);
  });

  it('says what the import would change: would_create and would_update, matched as the import matches', async () => {
    // Nothing yet: both concepts would be created.
    const fresh = await validate([goodConcept('Change Orders'), goodConcept('Change Customers')]).expect(200);
    expect(fresh.body).toMatchObject({ would_create: 2, would_update: 0 });

    await request(app.getHttpServer())
      .post('/api/v1/okf/import')
      .set('Cookie', cookie)
      .send({ files: [goodConcept('Change Orders')] })
      .expect(201);

    // One of them now exists (matched on title in its topic, as the import does).
    const again = await validate([goodConcept('Change Orders', 'New body.'), goodConcept('Change Customers')]).expect(200);
    expect(again.body).toMatchObject({ would_create: 1, would_update: 1 });

    // And the import agrees with its preview.
    const imported = await request(app.getHttpServer())
      .post('/api/v1/okf/import')
      .set('Cookie', cookie)
      .send({ files: [goodConcept('Change Orders', 'New body.'), goodConcept('Change Customers')] })
      .expect(201);
    expect(imported.body).toMatchObject({ created: 1, updated: 1 });

    // The archive door answers the same question.
    const archived = await validateArchive(createTarGz([goodConcept('Change Orders'), goodConcept('Change Suppliers')])).expect(200);
    expect(archived.body).toMatchObject({ would_create: 1, would_update: 1 });
  });

  it('omits would_create/would_update when the import would not run', async () => {
    // Refused whole: nothing would change, so there is no count to promise.
    const refused = await validate([goodConcept('Omit Sibling'), untypedConcept('Omit Untyped')]).expect(200);
    expect(refused.body.would_create).toBeUndefined();
    expect(refused.body.would_update).toBeUndefined();

    // Two concepts with one identity: the import's 409, so no counts either.
    const duplicate = await validate([goodConcept('Omit Twin'), { ...goodConcept('Omit Twin'), path: 'concepts/omit-twin-2.md' }]).expect(200);
    expect(duplicate.body.summary.conformant).toBe(true);
    expect(duplicate.body.would_create).toBeUndefined();
  });

  it('refuses a body that is not an archive with 400, at the validate and the import alike', async () => {
    await validateArchive(Buffer.from('definitely not gzip')).expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/okf/validate/archive')
      .set('Cookie', cookie)
      .set('Content-Type', 'application/gzip')
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/okf/import/archive')
      .set('Cookie', cookie)
      .set('Content-Type', 'application/gzip')
      .send(Buffer.from('definitely not gzip'))
      .expect(400);
  });

  it('writes nothing: no row, no file, no commit, no audit entry', async () => {
    // Prove the snapshot can SEE a write before trusting it to see none: an
    // import changes the tables, the content root and the commit count.
    const empty = await snapshot();
    await request(app.getHttpServer())
      .post('/api/v1/okf/import')
      .set('Cookie', cookie)
      .send({ files: [goodConcept('Control Import'), belowStandardConcept('Control Flagged')] })
      .expect(201);
    const before = await snapshot();
    expect(before.tables).not.toEqual(empty.tables);
    expect(before.content).not.toEqual(empty.content);
    expect(Object.values(before.commits).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    const auditBefore = before.tables['audit_log'];
    expect(auditBefore).toBeGreaterThan(0);
    const diagnosticsBefore = before.tables['sync_diagnostics'];

    // Every shape of dry run — clean, flagged, refused, and both archive forms —
    // including bundles that UPDATE the item just imported, which is where a
    // validate that secretly ran the import would show.
    await validate([goodConcept('Control Import', 'Changed body.'), goodConcept('Brand New')]).expect(200);
    await validate([belowStandardConcept('Control Flagged'), belowStandardConcept('Another Flagged')]).expect(200);
    await validate([untypedConcept('Refused One')]).expect(200);
    await validateArchive(
      createTarGz([
        goodConcept('Archived New'),
        { path: 'assets/diagram.png', content: PNG },
        { path: 'assets/diagram.png.meta.json', content: JSON.stringify({ mime: 'image/png', original_filename: 'd.png' }) },
      ]),
    ).expect(200);
    await validateArchive(createTarGz([untypedConcept('Archived Refused')])).expect(200);

    const after = await snapshot();
    expect(after.tables).toEqual(before.tables);
    expect(after.tables['audit_log']).toBe(auditBefore);
    expect(after.tables['sync_diagnostics']).toBe(diagnosticsBefore);
    expect(after.content).toEqual(before.content);
    expect(after.assets).toEqual(before.assets);
    expect(after.commits).toEqual(before.commits);
  });

  it('accepts a bundle well past the global 100 KB body cap, within the import’s 50 MB limit', async () => {
    // Random base64 in short lines (the shape of prose, not one 40 KB token), so
    // the gzipped archive stays large too and exercises the raw parser's limit
    // rather than being squeezed under the global cap.
    const body = () => (randomBytes(15_000).toString('base64').match(/.{1,76}/g) ?? []).join('\n\n');
    const files = Array.from({ length: 25 }, (_, n) => goodConcept(`Large Concept ${n}`, body()));
    expect(Buffer.byteLength(JSON.stringify({ files }))).toBeGreaterThan(5 * 100 * 1024);

    const res = await validate(files).expect(200);
    expect(res.body.summary).toMatchObject({ conformant: true, conceptCount: 25 });

    const archive = createTarGz(files);
    expect(archive.length).toBeGreaterThan(300 * 1024);
    const archived = await validateArchive(archive).expect(200);
    expect(archived.body.summary.conceptCount).toBe(25);
    // The lint dominates: ~4 s per half-megabyte validation on a dev laptop, twice
    // here. A generous bound so a loaded full run does not flake on it.
  }, 60_000);

  it('is admin-only: 403 for a signed-in non-admin, 401 anonymous, on both routes', async () => {
    const alice = await seedUserAndLogin(app);
    const archive = createTarGz([goodConcept('Private')]);

    await validate([goodConcept('Private')], alice.cookie).expect(403);
    await validateArchive(archive, alice.cookie).expect(403);
    await validate([goodConcept('Private')], null).expect(401);
    await validateArchive(archive, null).expect(401);
  });
});
