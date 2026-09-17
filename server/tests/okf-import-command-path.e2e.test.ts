/**
 * Issue 70: OKF import writes through ContentCommands.
 *
 * Before this, every import door (`POST /okf/import`, `POST /okf/import/archive`,
 * MCP `knowledge.import_okf`) wrote SQLite through `ItemsService.create/update`
 * -> `PagesService.create/update` with no canonical file and no `content_outbox`
 * row: the index could commit an imported item that nothing durably recorded as
 * owed to git. Now each imported item takes the command path every other door
 * takes — concept file first, index row + outbox row in one transaction, then
 * the git mirror, which acknowledges the row when it commits.
 *
 * Runs against a REAL git mirror (a temp content root, short commit debounce),
 * so "processed" means a commit landed, and "equivalent" means a drop-and-rebuild
 * of the index from those working trees gives the same items back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { sql, type Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import type { Viewer } from '@echozedlabs/knowledge-types';
import { digestOf } from '@echozedlabs/content-store';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { AuthService } from '../src/auth/auth.service.js';
import { CONTENT_REFUSED_ACTION } from '../src/content/content-commands.service.js';
import { OutboxService } from '../src/content/outbox.service.js';
import { KnowledgeQueryService } from '../src/query/knowledge-query.service.js';
import { ContentPathResolver } from '../src/storage/content-path.resolver.js';
import { IndexRebuildService } from '../src/storage/index-rebuild.service.js';
import { REVISION_MIRROR, type RevisionMirrorPort } from '../src/storage/revision-mirror.port.js';
import { createTarGz } from '../src/okf/tar.js';

interface BundleFile {
  path: string;
  content: string;
}

function slug(title: string): string {
  return title.toLowerCase().replace(/\s+/g, '-');
}

/** Conformant and policy-clean. */
function goodConcept(title: string, body = `Body of ${title}.`, extra: string[] = []): BundleFile {
  return {
    path: `concepts/${slug(title)}.md`,
    content: [
      '---',
      'type: Knowledge Page',
      `title: ${title}`,
      'description: A well-formed concept used by the command-path tests.',
      'categories:',
      '  - Reference',
      'tags:',
      '  - imported',
      'e3_status: published',
      ...extra,
      '---',
      '',
      body,
      '',
    ].join('\n'),
  };
}

/** Conformant OKF that fails this instance's publish rules (no category, no description), published. */
function belowStandardConcept(title: string): BundleFile {
  return {
    path: `concepts/${slug(title)}.md`,
    content: ['---', 'type: Knowledge Page', `title: ${title}`, 'e3_status: published', '---', '', 'Body.', ''].join('\n'),
  };
}

/** Not OKF: no `type` (a critical conformance issue). */
function untypedConcept(title: string): BundleFile {
  return {
    path: `concepts/${slug(title)}.md`,
    content: ['---', `title: ${title}`, 'description: Not a concept.', '---', '', 'Body.', ''].join('\n'),
  };
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

describe('OKF import through ContentCommands (issue 70)', () => {
  let app: INestApplication;
  let cookie: string;
  let adminId: string;
  let db: Kysely<Database>;
  let paths: ContentPathResolver;
  let outbox: OutboxService;
  let contentRoot: string;
  let assetsDir: string;

  beforeEach(async () => {
    contentRoot = mkdtempSync(join(tmpdir(), 'e3-okf-command-root-'));
    assetsDir = mkdtempSync(join(tmpdir(), 'e3-okf-command-assets-'));
    process.env['GIT_MIRROR_ROOT'] = contentRoot;
    process.env['GIT_COMMIT_QUIET_MS'] = '20';
    process.env['GIT_COMMIT_MAX_MS'] = '50';
    process.env['KNOWLEDGE_E3_ASSETS_DIR'] = assetsDir;
    app = await makeApp();
    ({ cookie, userId: adminId } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
    paths = app.get(ContentPathResolver);
    outbox = app.get(OutboxService);
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

  async function flush(): Promise<void> {
    await app.get<RevisionMirrorPort>(REVISION_MIRROR).flush?.();
  }

  function importJson(files: BundleFile[]) {
    return request(app.getHttpServer()).post('/api/v1/okf/import').set('Cookie', cookie).send({ files });
  }

  function validateJson(files: BundleFile[]) {
    return request(app.getHttpServer()).post('/api/v1/okf/validate').set('Cookie', cookie).send({ files }).expect(200);
  }

  function importArchive(files: BundleFile[]) {
    return request(app.getHttpServer())
      .post('/api/v1/okf/import/archive')
      .set('Cookie', cookie)
      .set('Content-Type', 'application/gzip')
      .send(createTarGz(files));
  }

  /** `knowledge.import_okf` over the streamable MCP endpoint, as the owner of a write-scoped token. */
  async function importMcp(files: BundleFile[]): Promise<any> {
    const minted = await request(app.getHttpServer())
      .post('/api/v1/me/tokens')
      .set('Cookie', cookie)
      .send({ name: 'importer', scope: 'write', expires_in_days: 30 })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/api/v1/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('Authorization', `Bearer ${minted.body.token as string}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'knowledge.import_okf', arguments: { files } } })
      .expect(200);
    const line = res.text.split('\n').find((l) => l.startsWith('data: '))!;
    return JSON.parse(line.slice('data: '.length)).result;
  }

  async function outboxRows(pageId: string) {
    return db.selectFrom('content_outbox').selectAll().where('page_id', '=', pageId).orderBy('created_at', 'asc').execute();
  }

  async function allOutboxRows() {
    return db.selectFrom('content_outbox').selectAll().execute();
  }

  async function pageCount(): Promise<number> {
    const row = await db.selectFrom('pages').select((eb) => eb.fn.countAll<number>().as('n')).where('deleted_at', 'is', null).executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /**
   * The command-path invariant for one imported item: its canonical file is on
   * disk at the path the row records, the row's digest is that file's, and the
   * newest outbox row names the same file and digest and the importing actor.
   */
  async function expectWrittenThroughCommands(pageId: string, rowsExpected: number): Promise<string> {
    const row = await db.selectFrom('pages').selectAll().where('id', '=', pageId).executeTakeFirstOrThrow();
    expect(row.source_id).toBe('main');
    expect(row.file_path).toBeTruthy();
    const abs = join(paths.mainDir, row.file_path!);
    expect(existsSync(abs)).toBe(true);
    const content = readFileSync(abs, 'utf8');
    expect(content).toContain(`e3_id: ${pageId}`);
    expect(row.file_digest).toBe(digestOf(content));

    const rows = await outboxRows(pageId);
    expect(rows).toHaveLength(rowsExpected);
    expect(rows.at(-1)).toMatchObject({
      kind: 'upsert',
      source_id: 'main',
      file_path: row.file_path,
      file_digest: row.file_digest,
      actor_id: adminId,
    });
    return row.file_path!;
  }

  it('REST JSON: one outbox row per item in the index transaction, acknowledged by the commit; re-import updates and matches validate', async () => {
    const bundle = [goodConcept('Command Orders'), goodConcept('Command Customers')];
    const preview = await validateJson(bundle);
    expect(preview.body).toMatchObject({ would_create: 2, would_update: 0 });

    const first = await importJson(bundle).expect(201);
    expect(first.body).toMatchObject({ created: 2, updated: 0 });
    expect(first.body.ids).toHaveLength(2);

    const filePaths: string[] = [];
    for (const id of first.body.ids as string[]) filePaths.push(await expectWrittenThroughCommands(id, 1));
    // Pending until the mirror commits: the row is what a restart would replay.
    expect((await allOutboxRows()).every((r) => r.processed_at === null)).toBe(true);

    await flush();
    expect(await outbox.pending()).toHaveLength(0);
    const tree = git(paths.mainDir, 'ls-tree', '-r', '--name-only', 'HEAD');
    for (const path of filePaths) expect(tree).toContain(path);
    expect(git(paths.mainDir, 'status', '--porcelain')).toBe('');

    // The import writes as the importing user; no refusal was recorded for a clean bundle.
    const audits = await db.selectFrom('audit_log').select(['action', 'actor_id', 'page_id']).execute();
    for (const id of first.body.ids as string[]) {
      expect(audits).toContainEqual({ action: 'page.create', actor_id: adminId, page_id: id });
    }

    // Re-import: the same two concepts (one changed) plus a new one.
    const again = [goodConcept('Command Orders', 'Orders, revised.'), goodConcept('Command Customers'), goodConcept('Command Suppliers')];
    const secondPreview = await validateJson(again);
    expect(secondPreview.body).toMatchObject({ would_create: 1, would_update: 2 });
    const second = await importJson(again).expect(201);
    // The preview promised exactly what the import did.
    expect({ would_create: second.body.created, would_update: second.body.updated }).toEqual({
      would_create: secondPreview.body.would_create,
      would_update: secondPreview.body.would_update,
    });
    expect(second.body.ids.slice(0, 2)).toEqual(first.body.ids);
    expect(await pageCount()).toBe(3);

    // An update is a second command write: a second outbox row, still one file.
    await expectWrittenThroughCommands(first.body.ids[0], 2);
    await expectWrittenThroughCommands(first.body.ids[1], 2);
    await expectWrittenThroughCommands(second.body.ids[2], 1);
    await flush();
    expect(await outbox.pending()).toHaveLength(0);
    expect(git(paths.mainDir, 'show', `HEAD:${filePaths[0]}`)).toContain('Orders, revised.');
  });

  it('archive: every concept goes through the command path and is committed', async () => {
    const res = await importArchive([goodConcept('Archive Alpha'), goodConcept('Archive Beta')]).expect(201);
    expect(res.body).toMatchObject({ created: 2, updated: 0 });
    for (const id of res.body.ids as string[]) await expectWrittenThroughCommands(id, 1);
    await flush();
    expect(await outbox.pending()).toHaveLength(0);
  });

  it('MCP import_okf: written through the command path as the token owner', async () => {
    const result = await importMcp([goodConcept('Mcp Imported')]);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ created: 1, updated: 0 });
    const [id] = result.structuredContent.ids as string[];
    await expectWrittenThroughCommands(id!, 1);
    await flush();
    expect(await outbox.pending()).toHaveLength(0);
  });

  it('a git rebuild of the imported working tree reproduces the imported items (equivalence)', async () => {
    await importJson([goodConcept('Rebuild Orders', 'See [[Rebuild Customers]].'), goodConcept('Rebuild Customers')]).expect(201);
    await importArchive([goodConcept('Rebuild Orders', 'See [[Rebuild Customers]] again.'), goodConcept('Rebuild Archive')]).expect(201);
    // An import never creates a topic, so the one the agent's concept names exists first.
    await request(app.getHttpServer()).post('/api/v1/topics').set('Cookie', cookie).send({ name: 'Ops', slug: 'ops' }).expect(201);
    const agent = await importMcp([goodConcept('Rebuild Agent', 'Imported by an agent.', ['e3_space: Ops'])]);
    expect(agent.isError).toBeUndefined();
    await flush();
    expect(await outbox.pending()).toHaveLength(0);
    expect(git(paths.mainDir, 'status', '--porcelain')).toBe('');

    const query = app.get(KnowledgeQueryService);
    const admin: Viewer = { userId: adminId, role: 'admin' };
    const slugs = ['rebuild-orders', 'rebuild-customers', 'rebuild-archive', 'rebuild-agent'];
    const snapshot = async () => {
      const topicSlug = new Map((await query.topics(admin)).map((t) => [t.id, t.slug] as const));
      const out: Record<string, unknown> = {};
      for (const s of slugs) {
        const it = await query.item(s, admin);
        out[s] = it && {
          id: it.id,
          title: it.title,
          status: it.status,
          type: it.type,
          topic: it.space_id ? topicSlug.get(it.space_id) : null,
          tags: [...it.tags].sort(),
          categories: it.categories,
          description: it.frontmatter['description'] ?? null,
          body_markdown: it.body_markdown.replace(/\n+$/, ''),
          owner_id: it.owner_id,
          created_at: it.created_at,
          updated_at: it.updated_at,
        };
      }
      return out;
    };
    const live = await snapshot();
    expect(Object.values(live).every(Boolean)).toBe(true);
    // The archive re-import updated the item the JSON import created. The live
    // row carries the concept's `type` and `description` and no leading blank
    // line: before the import mapped through the rebuild's own mapping, a live
    // import dropped `type` and kept that line, and a rebuild "changed" both.
    expect(live['rebuild-orders']).toMatchObject({
      body_markdown: 'See [[Rebuild Customers]] again.',
      status: 'published',
      type: 'Knowledge Page',
      description: 'A well-formed concept used by the command-path tests.',
    });
    expect(live['rebuild-agent']).toMatchObject({ topic: 'ops' });

    const system = await app.get(AuthService).ensureLocalSystemActor();
    const report = await app.get(IndexRebuildService).rebuildFromRepos([{ dir: paths.mainDir, sourceId: 'main' }], { actorId: system.id });
    expect(report.pages).toBe(4);
    expect(await snapshot()).toEqual(live);
  });

  it('keeps each item atomic: a failure after the business write inside the transaction leaves neither the row nor its outbox row, and a partial bundle says so', async () => {
    // Fail the OUTBOX insert for one file: it runs after that item's page,
    // version, taxonomy, link and FTS rows inside the same transaction, so a
    // row that survived it would be a business write without its outbox row.
    await sql`CREATE TRIGGER fail_import_outbox BEFORE INSERT ON content_outbox
      WHEN NEW.file_path LIKE '%atomic-second.md'
      BEGIN SELECT RAISE(ABORT, 'injected outbox failure'); END`.execute(db);

    // Alone, it fails as a whole: the original error, nothing written.
    const alone = await importJson([goodConcept('Atomic Second')]).expect(500);
    expect(alone.body.partial_import).toBeUndefined();
    expect(await pageCount()).toBe(0);
    expect(await allOutboxRows()).toHaveLength(0);
    expect(existsSync(join(paths.mainDir, 'default/concepts/atomic-second.md'))).toBe(false);

    // After a sibling landed, the failure is reported as a partial import.
    const res = await importJson([goodConcept('Atomic First'), goodConcept('Atomic Second')]).expect(500);
    expect(res.body.partial_import).toMatchObject({ created: 1, updated: 0, failed: { index: 1, title: 'Atomic Second' } });
    expect(res.body.message).toContain('after 1 item(s) were written');
    // No internal error text leaks into a 500.
    expect(res.body.message).not.toContain('injected');
    const [firstId] = res.body.partial_import.ids as string[];
    await expectWrittenThroughCommands(firstId!, 1);

    // The failed item: no row, no outbox row, and its file was compensated away.
    expect(await db.selectFrom('pages').select('id').where('title', '=', 'Atomic Second').execute()).toHaveLength(0);
    expect(await allOutboxRows()).toHaveLength(1);
    expect(existsSync(join(paths.mainDir, 'default/concepts/atomic-second.md'))).toBe(false);

    const rejected = await db.selectFrom('audit_log').select('payload_json').where('action', '=', 'okf.import_rejected').execute();
    expect(rejected.map((r) => JSON.parse(r.payload_json ?? '{}'))).toContainEqual(
      expect.objectContaining({ format: 'json', partial: { created: 1, updated: 0 } }),
    );
  });

  it('keeps 422 and 409 unchanged: a refused bundle writes no row, no file and no outbox row', async () => {
    const refused = await importJson([goodConcept('Refused Sibling'), untypedConcept('Refused Untyped')]).expect(422);
    expect(refused.body.reason).toBe('bundle_not_conformant');
    expect(refused.body.partial_import).toBeUndefined();

    const duplicate = await importJson([goodConcept('Twin Concept'), { ...goodConcept('Twin Concept'), path: 'concepts/twin-concept-2.md' }]).expect(409);
    expect(duplicate.body.message).toContain('duplicate import identity');
    expect(duplicate.body.partial_import).toBeUndefined();

    expect(await pageCount()).toBe(0);
    expect(await allOutboxRows()).toHaveLength(0);
    expect(existsSync(join(paths.mainDir, 'default'))).toBe(false);
  });

  it('keeps the policy tier warn-only: a below-standard published concept imports published, through the command path, with no content.refused row', async () => {
    const res = await importJson([belowStandardConcept('Below Standard Import')]).expect(201);
    expect(res.body.validation.summary).toMatchObject({ conformant: true, meetsPolicy: false });
    const [id] = res.body.ids as string[];

    const row = await db.selectFrom('pages').select(['status']).where('id', '=', id!).executeTakeFirstOrThrow();
    expect(row.status).toBe('published');
    await expectWrittenThroughCommands(id!, 1);

    // Recorded for Content health, exactly as before …
    const diagnostics = await db.selectFrom('sync_diagnostics').selectAll().where('cleared_at', 'is', null).execute();
    expect(diagnostics.map((d) => d.page_id)).toEqual([id]);
    // … and not a refusal: the gate is warn-only for the import source, as for git.
    expect(await db.selectFrom('audit_log').select('id').where('action', '=', CONTENT_REFUSED_ACTION).execute()).toHaveLength(0);
  });
});
