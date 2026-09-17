/**
 * The bundle integrity + lint gate (the product roadmap §7.1): import quarantine
 * at every import door, and `knowledge.validate_okf_bundle` as its dry run.
 *
 * The property under test throughout is the tier split. `conformant` (no
 * `critical` in the conformance tier) is the ONLY verdict that rejects — it says
 * "this is not an OKF bundle". `meetsPolicy` (no `error` in the policy tier) says
 * "this does not meet our editorial standards", which imports anyway and is
 * recorded instead. A test that only checked "bad input throws" would pass just
 * as well against the collapsed design this one exists to rule out.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { ItemsService } from '../src/items/items.service.js';
import type { ReadActor } from '../src/pages/pages.service.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';

interface BundleFile {
  path: string;
  content: string;
}

/** Conformant and policy-clean: typed, one primary category, a description. */
function goodConcept(title: string): BundleFile {
  return {
    path: `concepts/${title.toLowerCase().replace(/\s+/g, '-')}.md`,
    content: [
      '---',
      'type: Knowledge Page',
      `title: ${title}`,
      'description: A well-formed concept used by the gate tests.',
      'categories:',
      '  - Reference',
      'e3_status: published',
      '---',
      '',
      `Body of ${title}.`,
      '',
    ].join('\n'),
  };
}

/**
 * Conformant OKF — it HAS a `type`, which is all the format requires — but below
 * this instance's standards: no primary category, and published with no
 * description. Two policy errors, zero critical conformance issues.
 */
function belowStandardConcept(title: string): BundleFile {
  return {
    path: `concepts/${title.toLowerCase().replace(/\s+/g, '-')}.md`,
    content: ['---', 'type: Knowledge Page', `title: ${title}`, 'e3_status: published', '---', '', 'Body.', ''].join('\n'),
  };
}

/** Not OKF at all: no `type`, which is a `critical` conformance issue (v0.2 §11). */
function untypedConcept(title: string): BundleFile {
  return {
    path: `concepts/${title.toLowerCase().replace(/\s+/g, '-')}.md`,
    content: [
      '---',
      `title: ${title}`,
      'description: Looks like a document, is not an OKF concept.',
      'categories:',
      '  - Reference',
      '---',
      '',
      'Body.',
      '',
    ].join('\n'),
  };
}

describe('OKF bundle integrity gate e2e', () => {
  let app: INestApplication;
  let cookie: string;
  let items: ItemsService;
  let db: Kysely<Database>;
  let actor: ReadActor;

  beforeEach(async () => {
    app = await makeApp();
    const login = await seedAdminAndLogin(app);
    cookie = login.cookie;
    actor = { id: login.userId, role: 'admin' };
    items = app.get(ItemsService);
    db = app.get<Kysely<Database>>(KYSELY);
  });

  afterEach(async () => app.close());

  /** Raw JSON-RPC envelope: these tests assert on `error` as much as on `result`. */
  async function rpc(name: string, args: Record<string, unknown>, sessionCookie = cookie) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/mcp/jsonrpc')
      .set('Cookie', sessionCookie)
      .send({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } })
      .expect(200);
    return res.body as { result?: any; error?: { code: number; message: string; data?: any } };
  }

  async function itemCount(): Promise<number> {
    return (await items.list({ limit: 1000 }, actor)).length;
  }

  async function openDiagnostics() {
    return db.selectFrom('sync_diagnostics').selectAll().where('cleared_at', 'is', null).execute();
  }

  it('imports a conformant bundle unchanged — the gate refuses nothing it did not refuse before', async () => {
    const before = await itemCount();
    const files = [goodConcept('Gate Orders'), goodConcept('Gate Customers')];

    const { result, error } = await rpc('knowledge.import_okf', { files });
    expect(error).toBeUndefined();
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(await itemCount()).toBe(before + 2);

    expect(result.conformance.conformant).toBe(true);
    expect(result.validation.summary.conformant).toBe(true);
    expect(result.validation.summary.meetsPolicy).toBe(true);
    expect(await openDiagnostics()).toHaveLength(0);
  });

  it('quarantines a bundle with a critical conformance issue: rejected whole, nothing written', async () => {
    const before = await itemCount();
    // The valid concept comes FIRST, so a per-file gate would already have
    // written it by the time it reached the bad one.
    const files = [goodConcept('Gate Valid Sibling'), untypedConcept('Gate Untyped')];

    const { result, error } = await rpc('knowledge.import_okf', { files });
    expect(result).toBeUndefined();
    expect(error?.data?.reason).toBe('bundle_not_conformant');
    expect(error?.data?.validation.summary.conformant).toBe(false);
    expect(error?.data?.validation.summary.criticalCount).toBe(1);
    expect(error?.data?.validation.conformance.map((i: { code: string }) => i.code)).toContain('type.missing');

    // Not "an error was thrown" — nothing landed, including the file that was fine.
    expect(await itemCount()).toBe(before);
    expect(await items.getByTitle('Gate Valid Sibling', actor)).toBeNull();
    expect(await items.getByTitle('Gate Untyped', actor)).toBeNull();
  });

  it('quarantines the same bundle at the HTTP import door with 422 and the report', async () => {
    const before = await itemCount();
    const res = await request(app.getHttpServer())
      .post('/api/v1/okf/import')
      .set('Cookie', cookie)
      .send({ files: [goodConcept('Http Valid Sibling'), untypedConcept('Http Untyped')] })
      .expect(422);

    expect(res.body.reason).toBe('bundle_not_conformant');
    expect(res.body.validation.summary.conformant).toBe(false);
    expect(await itemCount()).toBe(before);
  });

  it('imports a conformant bundle that fails policy, and records its diagnostics for Content health', async () => {
    const before = await itemCount();
    const { result, error } = await rpc('knowledge.import_okf', { files: [belowStandardConcept('Gate Below Standard')] });

    // Policy is not a rejection reason: the bundle is valid OKF, so it lands.
    expect(error).toBeUndefined();
    expect(result.created).toBe(1);
    expect(await itemCount()).toBe(before + 1);
    expect(result.validation.summary.conformant).toBe(true);
    expect(result.validation.summary.meetsPolicy).toBe(false);
    expect(result.validation.policy.map((i: { code: string }) => i.code)).toEqual(
      expect.arrayContaining(['category.missing', 'description.missing']),
    );

    const pageId = result.ids[0] as string;
    const rows = await openDiagnostics();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.page_id).toBe(pageId);
    expect(rows[0]!.path).toBe('concepts/gate-below-standard.md');
    expect(JSON.parse(rows[0]!.diagnostics_json).map((d: { code: string }) => d.code)).toEqual(
      expect.arrayContaining(['category.missing', 'description.missing']),
    );

    // Content health's lint-failed queue is the surface those rows exist for.
    const health = await request(app.getHttpServer())
      .get('/api/v1/admin/health/content')
      .set('Cookie', cookie)
      .expect(200);
    expect(health.body.queues.lint_failed_inbound.items.map((i: { id: string }) => i.id)).toContain(pageId);

    // Re-importing the same concept, now fixed, clears the finding rather than
    // stacking a second one.
    const fixed = { ...goodConcept('Gate Below Standard'), path: 'concepts/gate-below-standard.md' };
    const second = await rpc('knowledge.import_okf', { files: [fixed] });
    expect(second.error).toBeUndefined();
    expect(second.result.validation.summary.meetsPolicy).toBe(true);
    expect(await openDiagnostics()).toHaveLength(0);
  });

  it('validate_okf_bundle returns the three tiers and both booleans, and writes nothing', async () => {
    const before = await itemCount();

    const clean = await rpc('knowledge.validate_okf_bundle', { files: [goodConcept('Preview Clean')] });
    expect(clean.error).toBeUndefined();
    expect(clean.result).toMatchObject({
      conformance: expect.any(Array),
      policy: expect.any(Array),
      advisory: expect.any(Array),
    });
    expect(clean.result.summary.conformant).toBe(true);
    expect(clean.result.summary.meetsPolicy).toBe(true);
    expect(clean.result.summary.conceptCount).toBe(1);
    expect(clean.result.summary_line).toContain('meets policy');

    // Conformant but below standard: would import, would be flagged.
    const flagged = await rpc('knowledge.validate_okf_bundle', { files: [belowStandardConcept('Preview Flagged')] });
    expect(flagged.result.summary.conformant).toBe(true);
    expect(flagged.result.summary.meetsPolicy).toBe(false);
    expect(flagged.result.summary.policyErrorCount).toBeGreaterThan(0);
    expect(flagged.result.summary.criticalCount).toBe(0);
    expect(flagged.result.summary_line).toContain('ACCEPTED');

    // Not OKF: would be refused whole.
    const rejected = await rpc('knowledge.validate_okf_bundle', { files: [untypedConcept('Preview Rejected')] });
    expect(rejected.result.summary.conformant).toBe(false);
    expect(rejected.result.summary.criticalCount).toBe(1);
    expect(rejected.result.conformance.map((i: { code: string }) => i.code)).toContain('type.missing');
    // A file the format rejects gets no policy opinion piled on top of it.
    expect(rejected.result.policy).toHaveLength(0);
    expect(rejected.result.summary_line).toContain('refused');

    // The tool is a dry run in the strongest sense: no item, no diagnostic.
    expect(await itemCount()).toBe(before);
    expect(await openDiagnostics()).toHaveLength(0);
  });

  it('reports unresolved cross-references as advisory only — never as a rejection', async () => {
    const orphan: BundleFile = {
      ...goodConcept('Gate Dangling'),
      content: goodConcept('Gate Dangling').content.replace('Body of Gate Dangling.', 'See [[Nowhere At All]].'),
    };
    const { result } = await rpc('knowledge.validate_okf_bundle', { files: [orphan] });
    expect(result.summary.conformant).toBe(true);
    expect(result.summary.meetsPolicy).toBe(true);
    expect(result.advisory.map((i: { code: string }) => i.code)).toContain('link.unresolved');
  });

  it('lets a read-scoped token list and call validate_okf_bundle', async () => {
    const minted = await request(app.getHttpServer())
      .post('/api/v1/me/tokens')
      .set('Cookie', cookie)
      .send({ name: 'ro', scope: 'read', expires_in_days: 30 })
      .expect(201);
    const token = minted.body.token as string;

    const call = (body: unknown) =>
      request(app.getHttpServer())
        .post('/api/v1/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', `Bearer ${token}`)
        .send(body as object);
    const parseRpc = (text: string) =>
      JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice('data: '.length));

    const list = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(200);
    const names: string[] = parseRpc(list.text).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('knowledge.validate_okf_bundle');
    // The dry run is visible to a read token precisely because its write-capable
    // twin is not.
    expect(names).not.toContain('knowledge.import_okf');

    const before = await itemCount();
    const called = await call({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'knowledge.validate_okf_bundle', arguments: { files: [goodConcept('Read Token Preview')] } },
    }).expect(200);
    const rpcResult = parseRpc(called.text).result;
    expect(rpcResult.isError).toBeUndefined();
    expect(rpcResult.structuredContent.summary.conformant).toBe(true);
    expect(rpcResult.structuredContent.summary.meetsPolicy).toBe(true);
    expect(await itemCount()).toBe(before);
  });

  it('lints against a topic\'s known vocabulary only when asked — the import never does', async () => {
    const files = [
      {
        ...goodConcept('Gate Unknown Category'),
        content: goodConcept('Gate Unknown Category').content.replace('  - Reference', '  - Nonexistent Category'),
      },
    ];

    const unscoped = await rpc('knowledge.validate_okf_bundle', { files });
    expect(unscoped.result.summary.meetsPolicy).toBe(true);

    const scoped = await rpc('knowledge.validate_okf_bundle', { files, topic: 'default' });
    expect(scoped.result.policy.map((i: { code: string }) => i.code)).toContain('category.unknown');
    expect(scoped.result.summary.meetsPolicy).toBe(false);

    // And the import, which does not consult the vocabulary, takes it clean.
    const imported = await rpc('knowledge.import_okf', { files });
    expect(imported.error).toBeUndefined();
    expect(imported.result.validation.summary.meetsPolicy).toBe(true);
    expect(await openDiagnostics()).toHaveLength(0);
  });
});
