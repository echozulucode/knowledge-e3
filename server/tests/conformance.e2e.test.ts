/**
 * Conformance suite (plan §9.5): "rebuild-from-git of a fixture set reproduces
 * the same KnowledgeQuery answers as the live index."
 *
 * A fixture corpus is built through the command path (REST /items, /pages, MCP
 * create_item) across two topics — one a subtree of the main repo, one bound to
 * a dedicated repo — plus a real uploaded asset referenced from an item, all
 * mirrored to real git working trees and flushed so every file (and the asset's
 * `.meta.json` descriptor sidecar) is committed. Every KnowledgeQuery answer is snapshotted as an admin and
 * as an anonymous visitor; then the derived index is dropped and rebuilt from
 * the working trees alone, and the same snapshot must come back — except for
 * the volatile fields listed (with reasons) in VOLATILE_ITEM_FIELDS below.
 *
 * The corpus also covers the **other** door content arrives through: two
 * ordinary Markdown repositories imported by `include_globs` (plan §8.3), one
 * `authoritative` (its ids go into the files) and one `reference` (its ids go
 * into `.e3/ids.json` beside the clone, because its working tree must stay
 * clean), each seeded upstream and pulled in by a real sync. Their files are
 * nowhere near the canonical `concepts/` layout, which is exactly why the
 * rebuild used to lose them entirely: `ContentStore.list()` walked the bundle
 * layout only, so a drop-and-rebuild dropped every imported item from the index
 * (issue 94). They are held to the same standard as everything else here —
 * same ids, types, titles, topics, timestamps and query answers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Kysely } from 'kysely';
import type { Viewer } from '@echozedlabs/knowledge-types';
import { digestOf } from '@echozedlabs/content-store';
import { curateCategories, seedAdminAndLogin } from './helpers.js';
import { AppModule } from '../src/app.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { configureApp } from '../src/bootstrap.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { OutboxService } from '../src/content/outbox.service.js';
import { descriptorSidecarName } from '../src/images/asset-descriptor.js';
import { ImagesService } from '../src/images/images.service.js';
import { CreateItemTool } from '../src/mcp/tools/create-item.tool.js';
import { KnowledgeQueryService } from '../src/query/knowledge-query.service.js';
import { ContentPathResolver } from '../src/storage/content-path.resolver.js';
import { IndexRebuildService, type RebuildRepo } from '../src/storage/index-rebuild.service.js';
import { RepoConfigService } from '../src/storage/repo-config.service.js';
import { REVISION_MIRROR } from '../src/storage/revision-mirror.port.js';
import { RoutingRevisionMirror } from '../src/storage/routing-revision-mirror.adapter.js';
import { globList, SourceRegistryService } from '../src/sync/source-registry.service.js';
import { SyncService } from '../src/sync/sync.service.js';

const ANON: Viewer = { userId: null, role: 'anonymous' };
const EPOCH = '1970-01-01T00:00:00.000Z';
const SEARCH_QUERIES = ['launch', 'pipeline', 'matlab'];
/** A real 1x1 PNG: the attachment policy types an upload by magic bytes, not by its header. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Item fields a rebuild (without history replay) is allowed to differ on.
 * Every other field — identity, content, taxonomy, topic, type, lifecycle and
 * trust signals, timestamps — must be identical. Do not widen this list to make
 * the test pass; fix the rebuild instead.
 *
 *  - version_token: the live chain counts every edit; a rebuild without
 *    `replayHistory` mints exactly one version per file (token 1).
 *  - current_version_id: version rows are re-minted with fresh ids.
 *  - raw_markdown: a live write keeps the user's document verbatim; a rebuild
 *    re-serializes the OKF file through the import mapping (key order, the
 *    exported lifecycle/`timestamp` keys, `e3_*` stripped). Its parsed
 *    projections (body_markdown, type, taxonomy, lifecycle) are compared.
 *
 * Normalizations applied to BOTH snapshots (see `snapshot`), each a known
 * export-side loss rather than a rebuild defect:
 *  - body_markdown: compared without trailing newlines — the OKF renderer
 *    writes exactly one, whatever the live body ended with (UI/MCP bodies end
 *    with none, REST raw bodies with one).
 *  - item().tags: compared order-insensitively — the exported file lists the
 *    indexed tags (sorted) ahead of the authored ones, so authored order is not
 *    in the file. (Summary/feed tags come from the index and are sorted anyway.)
 *  - related(): compared as a sorted list — backlink order is insertion order,
 *    which the contract does not specify.
 */
const VOLATILE_ITEM_FIELDS = ['version_token', 'current_version_id', 'raw_markdown'] as const;

interface ItemSnap {
  id: string;
  slug: string;
  title: string;
  status: string;
  type: string | null;
  topic: string | null;
  tags: string[];
  categories: string[];
  groups: string[];
  description: string | null;
  display_state: string;
  lifecycle_status: string;
  trust_tier: string;
  stale: boolean;
  stale_after: string | null;
  last_verified_at: string | null;
  generated_by: string | null;
  superseded_by: string | null;
  body_markdown: string;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  version_token?: number;
  current_version_id?: string | null;
  raw_markdown?: string;
}

interface TopicSnap {
  id: string;
  slug: string;
  name: string;
  visibility: string;
  presentation: string;
  start_here: string | null | undefined;
  landing_markdown: string | null | undefined;
  counts: { items: number; published: number } | undefined;
  sections: { slug: string; slot: string | undefined; items: string[] }[];
}

interface Snapshot {
  items: Record<string, ItemSnap | null>;
  topics: Record<string, TopicSnap | null>;
  feed: { slug: string; published_at: string | null | undefined }[];
  search: Record<string, { hits: string[]; groups: { key: string; total: number; hits: string[] }[] }>;
  related: Record<string, string[]>;
  changedSince: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/** An ordinary Markdown file: frontmatter (or none at all) plus a body. */
function doc(frontmatter: string | null, body: string): string {
  return frontmatter === null ? `${body}\n` : `---\n${frontmatter}\n---\n\n${body}\n`;
}

function writeAt(root: string, path: string, content: string): void {
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/**
 * One imported repository: an upstream bare origin plus a working clone that
 * plays "the repository we import", seeded with plain Markdown at paths that
 * have nothing to do with the canonical `concepts/` layout.
 */
interface ImportFixture {
  /** Source registry id, `topic:<slug>`. */
  id: string;
  slug: string;
  name: string;
  role: 'authoritative' | 'reference';
  mode: 'direct' | 'read-only';
  include: string[];
  exclude: string[];
  defaultType: string;
  files: [string, string][];
  /** Basenames that must NOT become items, whatever the globs say. */
  notItems: string[];
}

describe('conformance: rebuild-from-git reproduces the live KnowledgeQuery answers', () => {
  let app: INestApplication;
  let cookie: string;
  let adminId: string;
  let admin: Viewer;
  let db: Kysely<Database>;
  let paths: ContentPathResolver;
  let mirror: RoutingRevisionMirror;
  let query: KnowledgeQueryService;
  let bareDir: string;
  let rootDir: string;

  beforeEach(async () => {
    process.env['DB_URL'] = ':memory:';
    // Pin the content root so the asset store resolves to `<root>/main/assets` —
    // the very working tree the routing mirror commits from, and where
    // `rebuildFromRepos` looks for the sidecar descriptors. Without this the
    // test-mode default parks assets in ./data/assets, outside any repo.
    rootDir = mkdtempSync(join(tmpdir(), 'e3-conformance-root-'));
    process.env['GIT_MIRROR_ROOT'] = rootDir;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REVISION_MIRROR)
      .useFactory({
        // The production wiring: the mirror commits from the working trees the
        // write-first command writes into (main + dedicated topic repos).
        factory: (kysely: Kysely<Database>, outbox: OutboxService, resolver: ContentPathResolver) =>
          new RoutingRevisionMirror(resolver.root, kysely, {
            quietMs: 20,
            maxMs: 50,
            onCommitted: (committed, at) => outbox.markProcessed(committed.map((c) => ({ pageId: c.itemId, path: c.path })), at),
          }),
        inject: [KYSELY, OutboxService, ContentPathResolver],
      })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app, { webDist: null });
    await app.init();
    ({ cookie, userId: adminId } = await seedAdminAndLogin(app));
    admin = { userId: adminId, role: 'admin' };
    db = app.get<Kysely<Database>>(KYSELY);
    paths = app.get(ContentPathResolver);
    mirror = app.get<RoutingRevisionMirror>(REVISION_MIRROR);
    query = app.get(KnowledgeQueryService);
    bareDir = mkdtempSync(join(tmpdir(), 'e3-conformance-'));
  });

  afterEach(async () => {
    await app.close();
    delete process.env['GIT_MIRROR_ROOT'];
    rmSync(bareDir, { recursive: true, force: true });
    rmSync(rootDir, { recursive: true, force: true });
  });

  // --- fixture builders: every item goes through a command-path door ---------

  async function restItem(raw: string): Promise<{ id: string; slug: string }> {
    const res = await request(app.getHttpServer()).post('/api/v1/items').set('Cookie', cookie).send({ raw }).expect(201);
    await sleep(3); // distinct timestamps so feed/changedSince order is not a tie
    return res.body.item;
  }

  async function uiPage(body: Record<string, unknown>): Promise<{ id: string; slug: string }> {
    const res = await request(app.getHttpServer()).post('/api/v1/pages').set('Cookie', cookie).send(body).expect(201);
    await sleep(3);
    return res.body.page;
  }

  /** Soft delete through the REST door (issue 76: the file must leave the tree). */
  async function deleteItem(id: string): Promise<void> {
    await request(app.getHttpServer()).delete(`/api/v1/pages/${id}`).set('Cookie', cookie).expect(204);
    await sleep(3);
  }

  async function restoreItem(id: string): Promise<void> {
    await request(app.getHttpServer()).post(`/api/v1/pages/${id}/restore`).set('Cookie', cookie).expect(201);
    await sleep(3);
  }

  async function mcpItem(input: Record<string, unknown>): Promise<{ id: string; slug: string }> {
    const result = await app.get(CreateItemTool).execute(adminId, input);
    await sleep(3);
    return result.item as { id: string; slug: string };
  }

  /**
   * An asset uploaded through the real REST door; the stored name is
   * content-addressed. The upload signals the mirror fire-and-forget, so this
   * commits it before any concept is authored — both to keep the fixture
   * deterministic and because an asset-only commit is the ADR-0003 durability
   * path (bytes + `.meta.json` sidecar, no index.md).
   */
  async function uploadAsset(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/images')
      .set('Cookie', cookie)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(201);
    await mirror.notifyAssetsChanged();
    await mirror.flush();
    return res.body.file as string;
  }

  /**
   * Seed an upstream repository of ordinary Markdown, register it as a source
   * with `include_globs`, and pull it in through a real sync — the same door
   * production uses. Returns the slugs it produced.
   */
  async function importSource(fixture: ImportFixture): Promise<string[]> {
    const bare = join(bareDir, `${fixture.slug}.git`);
    const clone = join(bareDir, `${fixture.slug}-upstream`);
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
    execFileSync('git', ['clone', '-q', bare, clone]);
    git(clone, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(clone, 'config', 'user.email', 'upstream@example.com');
    git(clone, 'config', 'user.name', 'Upstream');
    for (const [path, content] of fixture.files) writeAt(clone, path, content);
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'seed an ordinary markdown repository');
    git(clone, 'push', '-q', 'origin', 'main');

    await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', cookie)
      .send({ name: fixture.name, slug: fixture.slug })
      .expect(201);
    await app.get(SourceRegistryService).upsert(fixture.id, {
      remote_url: bare,
      branch: 'main',
      role: fixture.role,
      mode: fixture.mode,
      default_status: 'published',
      include_globs: fixture.include,
      exclude_globs: fixture.exclude,
      default_type: fixture.defaultType,
    });
    const status = await app.get(SyncService).runNow(fixture.id);
    expect(status).toMatchObject({ source: fixture.id, state: 'idle', last_error: null, conflicted_paths: [] });
    // Distinct timestamps, so feed/changedSince order is never a tie.
    await sleep(3);

    const rows = await db
      .selectFrom('pages')
      .select('slug')
      .where('source_id', '=', fixture.id)
      .where('deleted_at', 'is', null)
      .orderBy('slug')
      .execute();
    return rows.map((r) => r.slug);
  }

  /** The two imported repositories: one authoritative, one reference. */
  const IMPORTS: ImportFixture[] = [
    {
      id: 'topic:handbook',
      slug: 'handbook',
      name: 'Handbook',
      role: 'authoritative',
      mode: 'direct',
      include: ['docs/**/*.md'],
      exclude: ['docs/archive/**'],
      defaultType: 'How-To',
      files: [
        // Types from `default_type`; the id is written back into the file.
        ['docs/setup-guide.md', doc('title: Setup Guide\ncategories: [guides]\ndescription: How the handbook is set up.', 'Follow these steps.')],
        // Excluded by `exclude_globs` — must stay out of the index either way.
        ['docs/archive/retired.md', doc('title: Retired\ncategories: [guides]\ndescription: Gone.', 'Old.')],
      ],
      notItems: ['retired'],
    },
    {
      id: 'topic:library',
      slug: 'library',
      name: 'Library',
      role: 'reference',
      mode: 'read-only',
      include: ['notes/**/*.md'],
      exclude: [],
      defaultType: 'Concept',
      files: [
        // No `title` at all: it is derived from the first heading, on both the
        // sync path and the rebuild path. The id lives in `.e3/ids.json`.
        ['notes/field-notes.md', doc('categories: [guides]\ndescription: Notes from the field.', '# Field Notes\n\nObservations worth keeping.')],
        // Reserved and asset paths are never items, whatever the globs select.
        ['notes/index.md', doc(null, '# Notes')],
        ['notes/assets/diagram.md', doc(null, '# Diagram')],
      ],
      notItems: ['notes', 'diagram'],
    },
  ];

  /**
   * What the CLI restore path (`scripts/rebuild-from-git.ts`) builds from the
   * registry: the globs that decide which files are items at all, the type and
   * status defaults an imported file that names neither is given, the role, and
   * the bound topic's name (read now, because the rebuild wipes and recreates
   * the topic).
   */
  async function importRebuildRepos(): Promise<RebuildRepo[]> {
    const registry = app.get(SourceRegistryService);
    const repos: RebuildRepo[] = [];
    for (const fixture of IMPORTS) {
      const row = (await registry.get(fixture.id))!;
      const space = await db.selectFrom('spaces').select('name').where('id', '=', row.space_id!).executeTakeFirstOrThrow();
      repos.push({
        dir: join(paths.topicsDir, fixture.slug),
        sourceId: row.id,
        include: globList(row.include_globs),
        exclude: globList(row.exclude_globs),
        defaultType: row.default_type,
        defaultStatus: row.default_status,
        role: row.role,
        topicName: space.name,
      });
    }
    return repos;
  }

  /** Two topics: `ops` as a subtree of the main repo, `portal` bound to a dedicated repo. */
  async function buildFixture(): Promise<{ slugs: string[]; pipelineId: string; assetFile: string }> {
    // Curate `guides` before anything is authored into it. Primary categories
    // are curated, not emergent (Eric, 2026-09-11 — issues 97/106), so a
    // fixture item that publishes in one call (the MCP door) is refused unless
    // its category is in the `primary_categories` catalog first.
    await request(app.getHttpServer())
      .post('/api/v1/taxonomy/categories')
      .set('Cookie', cookie)
      .send({ slug: 'guides', name: 'Guides' })
      .expect(201);
    // Every item below that publishes in one call (REST, the Compose door and
    // MCP alike — issue 98) carries a curated category and a `description`.
    await curateCategories(app, 'engineering');
    const topic = await request(app.getHttpServer())
      .post('/api/v1/topics')
      .set('Cookie', cookie)
      .send({
        name: 'Portal',
        slug: 'portal',
        presentation: 'portal',
        start_here: 'use-ai-with-matlab',
        landing_markdown: 'Short gateway prose for the portal.',
      })
      .expect(201);
    const bare = join(bareDir, 'portal.git');
    execFileSync('git', ['init', '--bare', bare]);
    await app.get(RepoConfigService).upsert(topic.body.topic.id, { remote_url: bare }, adminId);

    // Uploaded BEFORE the items: `image_links` resolves against the images index
    // at save time, exactly as it does after a rebuild.
    const assetFile = await uploadAsset();

    const created: { id: string; slug: string }[] = [];
    // main repo, topic subtree `ops/concepts/`
    const pipeline = await restItem(
      '---\ntitle: Deployment Pipeline\ntype: Concept\nstatus: published\ntopic: Ops\ntags: [ops, ci]\ncategories: [engineering]\ngroups: [platform]\ndescription: How a change reaches production.\nstale_after: 2999-01-01\n---\nThe pipeline builds, tests, and ships every change.\n',
    );
    created.push(pipeline);
    created.push(
      await restItem(
        '---\ntitle: Rotate Secrets\ntype: How-To\nstatus: published\ntopic: Ops\ncategories: [guides]\ndescription: Rotating credentials safely.\ntags: [ops, security]\nverified:\n  - by: human:eric\n    at: 2026-08-01T00:00:00.000Z\n---\nSee [[Deployment Pipeline]] before rotating anything.\n',
      ),
    );
    created.push(
      await restItem(
        '---\ntitle: Launch Plan\ntype: Blog Post\nstatus: published\ntopic: Ops\ncategories: [guides]\ndescription: The launch plan.\ntags: [launch]\nauthor: Ada\nseries: launch\nseries_order: 1\npublished_at: 2026-01-15T00:00:00.000Z\n---\nThe launch plan, step by step.\n',
      ),
    );
    created.push(
      await restItem(
        `---\ntitle: Launch Retrospective\ntype: Blog Post\nstatus: published\ntopic: Ops\ncategories: [guides]\ndescription: What the launch taught us.\ntags: [launch]\nauthors: [Ada, Grace]\nseries: launch\nseries_order: 2\npublished_at: 2026-02-01T00:00:00.000Z\ncover: assets/${assetFile}\n---\nWhat the launch taught us about the pipeline.\n\n![Diagram](/assets/${assetFile})\n`,
      ),
    );
    created.push(
      await restItem(
        '---\ntitle: Legacy Runbook\ntype: Runbook\nstatus: published\ntopic: Ops\ncategories: [guides]\ndescription: The old pipeline runbook.\nstale_after: 2020-01-01\n---\nPast its review date; still describes the pipeline.\n',
      ),
    );
    created.push(
      await restItem(
        '---\ntitle: Generated Digest\ntype: Concept\nstatus: published\ntopic: Ops\ncategories: [guides]\ndescription: Nightly pipeline digest.\ngenerated:\n  by: process:nightly-digest\n  at: 2026-08-15T03:00:00.000Z\n---\nNightly digest of [[Deployment Pipeline]] activity.\n',
      ),
    );
    created.push(
      await uiPage({
        title: 'Unfinished Note',
        body: 'Draft thoughts on the launch.',
        status: 'draft',
        frontmatter: { type: 'Concept', topic: 'Ops' },
      }),
    );
    // dedicated repo `topics/portal/concepts/`
    created.push(
      await uiPage({
        title: 'Use AI With MATLAB',
        body: 'Start here: how to use AI with MATLAB and Simulink.',
        status: 'published',
        frontmatter: { type: 'How-To', topic: 'Portal', categories: ['guides'], description: 'Start here for AI with MATLAB.' },
      }),
    );
    created.push(
      await restItem(
        '---\ntitle: Prompting Basics\ntype: How-To\nstatus: published\ntopic: Portal\ncategories: [guides]\ndescription: Prompting patterns for MATLAB.\ntags: [matlab, prompting]\n---\nPrompting patterns that work for MATLAB questions.\n',
      ),
    );
    created.push(
      await mcpItem({
        // Published through MCP in one call, which the publish gate holds to the
        // content-model rules, so this fixture carries a known primary category
        // and a `description` the way a real agent's would after validate_item.
        title: 'Agent Field Note',
        body: 'An agent-authored FAQ about MATLAB licensing.',
        space: 'Portal',
        status: 'published',
        frontmatter: { type: 'FAQ', categories: ['guides'], description: 'How MATLAB licensing works for agents.' },
      }),
    );

    // A soft delete and a delete-then-restore, so rebuild parity covers both
    // (issue 76). The deleted item's slug stays in the snapshot set: the answer
    // must be `null` live AND after the rebuild — before the delete was
    // inverted its file stayed in the tree and the rebuild brought it back.
    const retired = await restItem(
      '---\ntitle: Retired Note\ntype: Concept\nstatus: published\ntopic: Ops\ncategories: [guides]\ndescription: A retired note.\n---\nSuperseded by the runbook.\n',
    );
    created.push(retired);
    await deleteItem(retired.id);
    const reinstated = await restItem(
      '---\ntitle: Reinstated Note\ntype: Concept\nstatus: published\ntopic: Ops\ncategories: [guides]\ndescription: A reinstated note.\n---\nDeleted by mistake, then brought back.\n',
    );
    created.push(reinstated);
    await deleteItem(reinstated.id);
    await restoreItem(reinstated.id);

    await request(app.getHttpServer())
      .put('/api/v1/sections')
      .set('Cookie', cookie)
      .send({
        sections: [
          { name: 'Essential guidance', type: 'How-To', space: 'portal', slot: 'essential', order: 1 },
          { name: 'Latest posts', type: 'Blog Post', space: 'ops', slot: 'latest', order: 2 },
        ],
      })
      .expect(200);

    // The imported repositories, last, and one source at a time so no two
    // imported items share a creation timestamp.
    const imported: string[] = [];
    for (const fixture of IMPORTS) imported.push(...(await importSource(fixture)));

    return { slugs: [...created.map((c) => c.slug), ...imported], pipelineId: pipeline.id, assetFile };
  }

  // --- the snapshot -----------------------------------------------------------

  async function snapshot(viewer: Viewer, slugs: string[], relatedIds: string[]): Promise<Snapshot> {
    const topicSlugById = new Map((await query.topics(admin)).map((t) => [t.id, t.slug] as const));
    const items: Snapshot['items'] = {};
    for (const slug of slugs) {
      const it = await query.item(slug, viewer);
      items[slug] = it
        ? {
            id: it.id,
            slug: it.slug,
            title: it.title,
            status: it.status,
            type: it.type,
            topic: it.space_id ? (topicSlugById.get(it.space_id) ?? it.space_id) : null,
            tags: [...it.tags].sort(), // order-insensitive, see VOLATILE_ITEM_FIELDS
            categories: it.categories,
            groups: it.groups,
            description: typeof it.frontmatter['description'] === 'string' ? it.frontmatter['description'] : null,
            display_state: it.display_state,
            lifecycle_status: it.lifecycle_status,
            trust_tier: it.trust_tier,
            stale: it.stale,
            stale_after: it.stale_after,
            last_verified_at: it.last_verified_at,
            generated_by: it.generated_by,
            superseded_by: it.superseded_by,
            body_markdown: it.body_markdown.replace(/\n+$/, ''), // trailing newlines, see VOLATILE_ITEM_FIELDS
            owner_id: it.owner_id,
            created_at: it.created_at,
            updated_at: it.updated_at,
            version_token: it.version_token,
            current_version_id: it.current_version_id,
            raw_markdown: it.raw_markdown,
          }
        : null;
    }
    const topics: Snapshot['topics'] = {};
    for (const slug of ['ops', 'portal', 'handbook', 'library', 'default']) {
      const t = await query.topic(slug, viewer);
      topics[slug] = t
        ? {
            id: t.id,
            slug: t.slug,
            name: t.name,
            visibility: t.visibility,
            presentation: t.presentation,
            start_here: t.start_here,
            landing_markdown: t.landing_markdown,
            counts: t.counts,
            sections: (t.sections ?? []).map((s) => ({ slug: s.slug, slot: s.slot, items: (s.items ?? []).map((i) => i.slug) })),
          }
        : null;
    }
    const feed = (await query.feed({}, viewer)).items.map((e) => ({ slug: e.slug, published_at: e.published_at }));
    const search: Snapshot['search'] = {};
    for (const q of SEARCH_QUERIES) {
      const set = await query.search({ q }, viewer);
      search[q] = {
        hits: set.results.map((h) => h.slug),
        groups: set.groups.map((g) => ({ key: g.key, total: g.total, hits: g.hits.map((h) => h.slug) })),
      };
    }
    const related: Snapshot['related'] = {};
    for (const id of relatedIds) related[id] = (await query.related(id, viewer)).map((s) => s.slug).sort(); // see VOLATILE_ITEM_FIELDS
    const changedSince = (await query.changedSince(EPOCH, viewer)).items.map((s) => s.slug);
    return { items, topics, feed, search, related, changedSince };
  }

  function stripVolatile(snap: Snapshot): Snapshot {
    const items: Snapshot['items'] = {};
    for (const [slug, it] of Object.entries(snap.items)) {
      if (!it) {
        items[slug] = null;
        continue;
      }
      const copy: ItemSnap = { ...it };
      for (const f of VOLATILE_ITEM_FIELDS) delete copy[f];
      items[slug] = copy;
    }
    return { ...snap, items };
  }

  function gitClean(dir: string): boolean {
    return execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim() === '';
  }

  it('answers item/topic/feed/search/related/changedSince identically after a drop-and-rebuild', async () => {
    const { slugs, pipelineId, assetFile } = await buildFixture();
    expect(slugs).toHaveLength(14);
    expect(slugs).toContain('setup-guide');
    expect(slugs).toContain('field-notes');

    // The live index links the uploaded asset to the item that embeds it.
    const images = app.get(ImagesService);
    expect(await images.list()).toEqual([
      expect.objectContaining({ file: assetFile, mime: 'image/png', byte_size: PNG.length, used_by: 1, orphan: false }),
    ]);

    // Every file is committed in its repo before we snapshot.
    await mirror.flush();
    const mainDir = paths.mainDir;
    const portalDir = join(paths.topicsDir, 'portal');
    expect(gitClean(mainDir)).toBe(true);
    expect(gitClean(portalDir)).toBe(true);
    expect((await app.get(OutboxService).pending()).length).toBe(0);
    const committed = execFileSync('git', ['-C', portalDir, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' });
    expect(committed).toContain('concepts/use-ai-with-matlab.md');
    expect(committed).toContain('index.md');
    // The asset is git-of-record too: the bytes AND the descriptor sidecar that
    // drives the media half of the rebuild (ADR-0003).
    const mainTree = execFileSync('git', ['-C', mainDir, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' });
    expect(mainTree).not.toContain('ops/concepts/retired-note.md');
    expect(mainTree).toContain('ops/concepts/reinstated-note.md');
    expect(mainTree).toContain(`assets/${assetFile}`);
    expect(mainTree).toContain(`assets/${descriptorSidecarName(assetFile)}`);

    const relatedIds = [pipelineId];
    const liveAdmin = await snapshot(admin, slugs, relatedIds);
    const liveAnon = await snapshot(ANON, slugs, relatedIds);

    // Sanity: the live corpus exercises what the suite claims to cover.
    expect(liveAdmin.items['legacy-runbook']).toMatchObject({ stale: true, display_state: 'needs-review', type: 'Runbook' });
    expect(liveAdmin.items['rotate-secrets']).toMatchObject({ trust_tier: 'human-reviewed', last_verified_at: expect.any(String) });
    expect(liveAdmin.items['generated-digest']).toMatchObject({ generated_by: 'process:nightly-digest' });
    expect(liveAdmin.items['unfinished-note']).toMatchObject({ display_state: 'draft' });
    expect(liveAnon.items['unfinished-note']).toBeNull();
    // The deleted item answers `null` to everyone and its file is gone from the
    // tree; the restored one is back, once.
    expect(liveAdmin.items['retired-note']).toBeNull();
    expect(liveAnon.items['retired-note']).toBeNull();
    expect(liveAdmin.items['reinstated-note']).toMatchObject({ status: 'published', topic: 'ops' });
    expect(liveAdmin.items['agent-field-note']).toMatchObject({ type: 'FAQ', topic: 'portal' });
    expect(liveAdmin.topics['portal']).toMatchObject({
      presentation: 'portal',
      start_here: 'use-ai-with-matlab',
      landing_markdown: 'Short gateway prose for the portal.',
    });
    expect(liveAdmin.topics['portal']!.sections.map((s) => s.slot)).toEqual(['essential']);
    expect(liveAdmin.topics['ops']!.sections).toEqual([{ slug: 'latest-posts', slot: 'latest', items: ['launch-retrospective', 'launch-plan'] }]);
    expect(liveAdmin.related[pipelineId]).toEqual(['generated-digest', 'rotate-secrets']);
    expect(liveAdmin.feed).toHaveLength(12);
    expect(liveAdmin.search['launch']!.groups.map((g) => g.key)).toContain('Blog Post');
    expect(liveAdmin.items['launch-retrospective']!.body_markdown).toContain(`/assets/${assetFile}`);

    // The imported corpus: typed from `default_type`, titled from the file (or
    // its first heading), filed under the source's topic, and published because
    // the lint passed — if any of that were wrong the comparison below would
    // still pass, so assert it here rather than trusting the round trip.
    expect(liveAdmin.items['setup-guide']).toMatchObject({
      title: 'Setup Guide',
      type: 'How-To',
      status: 'published',
      topic: 'handbook',
      categories: ['guides'],
      description: 'How the handbook is set up.',
    });
    expect(liveAdmin.items['field-notes']).toMatchObject({
      title: 'Field Notes', // derived from `# Field Notes`; the file has no title
      type: 'Concept',
      status: 'published',
      topic: 'library',
    });
    expect(liveAdmin.topics['handbook']).toMatchObject({ name: 'Handbook', counts: { items: 1, published: 1 } });
    expect(liveAdmin.topics['library']).toMatchObject({ name: 'Library', counts: { items: 1, published: 1 } });
    const importedIds = { setup: liveAdmin.items['setup-guide']!.id, notes: liveAdmin.items['field-notes']!.id };

    // The two ways an imported id is kept: in the file (authoritative) and in
    // `.e3/ids.json` beside the clone (reference, whose tree must stay clean).
    const handbookDir = join(paths.topicsDir, 'handbook');
    const libraryDir = join(paths.topicsDir, 'library');
    const setupGuideFile = join(handbookDir, 'docs', 'setup-guide.md');
    const fieldNotesFile = join(libraryDir, 'notes', 'field-notes.md');
    const idsFile = join(libraryDir, '.e3', 'ids.json');
    expect(readFileSync(setupGuideFile, 'utf8')).toContain(`e3_id: ${importedIds.setup}`);
    const fieldNotesBefore = readFileSync(fieldNotesFile, 'utf8');
    expect(fieldNotesBefore).not.toContain('e3_id');
    const idsBefore = readFileSync(idsFile, 'utf8');
    expect(JSON.parse(idsBefore).ids['notes/field-notes.md']).toBe(importedIds.notes);
    expect(gitClean(handbookDir)).toBe(true);
    expect(gitClean(libraryDir)).toBe(true);

    // Drop and rebuild the whole derived index from every working tree — the
    // canonical bundles AND the two imported repositories. The rebuild actor is
    // the local system actor, exactly as `scripts/rebuild-from-git.ts` runs it,
    // which is also the actor the sync path indexed the imports as.
    const systemActor = await app.get(AuthService).ensureLocalSystemActor();
    const report = await app.get(IndexRebuildService).rebuildFromRepos(
      [
        { dir: mainDir, sourceId: 'main' },
        { dir: portalDir, sourceId: 'topic:portal' },
        ...(await importRebuildRepos()),
      ],
      { actorId: systemActor.id },
    );
    expect(report.pages).toBe(13);
    // Two of them came in through `include_globs`, not the bundle layout.
    expect(report.imported).toBe(2);
    // The asset came back from its sidecar, not from the dropped index.
    expect(report.images).toBe(1);

    // A rebuild reads; it never writes. That is the whole reason
    // `.e3/ids.json` exists for a `reference` source, whose working tree must
    // stay clean, and it must hold for the authoritative one too.
    expect(gitClean(libraryDir)).toBe(true);
    expect(gitClean(handbookDir)).toBe(true);
    expect(readFileSync(fieldNotesFile, 'utf8')).toBe(fieldNotesBefore);
    expect(readFileSync(idsFile, 'utf8')).toBe(idsBefore);

    const rebuiltAdmin = await snapshot(admin, slugs, relatedIds);
    const rebuiltAnon = await snapshot(ANON, slugs, relatedIds);

    expect(stripVolatile(rebuiltAdmin)).toEqual(stripVolatile(liveAdmin));
    expect(stripVolatile(rebuiltAnon)).toEqual(stripVolatile(liveAnon));

    // The asset survives the drop-and-rebuild: the sidecar repopulates `images`,
    // the item's body repopulates `image_links`, and the item still resolves it
    // through KnowledgeQuery.
    expect(await images.list()).toEqual([
      expect.objectContaining({ file: assetFile, mime: 'image/png', byte_size: PNG.length, used_by: 1, orphan: false }),
    ]);
    const retro = await db.selectFrom('pages').select('id').where('slug', '=', 'launch-retrospective').executeTakeFirstOrThrow();
    expect(
      await db
        .selectFrom('image_links')
        .innerJoin('images', 'images.id', 'image_links.image_id')
        .select(['image_links.page_id as page_id', 'images.file as file'])
        .execute(),
    ).toEqual([{ page_id: retro.id, file: assetFile }]);
    expect(rebuiltAdmin.items['launch-retrospective']!.body_markdown).toContain(`/assets/${assetFile}`);
    expect(rebuiltAnon.items['launch-retrospective']!.body_markdown).toContain(`/assets/${assetFile}`);

    // The imported items came back under the ids they had — from the file for
    // the authoritative source, from `.e3/ids.json` for the reference one.
    expect(rebuiltAdmin.items['setup-guide']!.id).toBe(importedIds.setup);
    expect(rebuiltAdmin.items['field-notes']!.id).toBe(importedIds.notes);

    // Reserved files, `assets/**` and `exclude_globs` are still not items after
    // a rebuild — the globs widen what is enumerated, they do not override the
    // exclusions.
    for (const fixture of IMPORTS) {
      for (const slug of fixture.notItems) expect(await query.item(slug, admin)).toBeNull();
    }

    // The rebuilt rows point at the files they derive from.
    const rows = await db.selectFrom('pages').select(['slug', 'source_id', 'file_path', 'file_digest']).execute();
    expect(rows.find((r) => r.slug === 'deployment-pipeline')).toMatchObject({ source_id: 'main', file_path: 'ops/concepts/deployment-pipeline.md' });
    expect(rows.find((r) => r.slug === 'prompting-basics')).toMatchObject({ source_id: 'topic:portal', file_path: 'concepts/prompting-basics.md' });
    expect(rows.find((r) => r.slug === 'setup-guide')).toMatchObject({ source_id: 'topic:handbook', file_path: 'docs/setup-guide.md' });
    expect(rows.find((r) => r.slug === 'field-notes')).toMatchObject({ source_id: 'topic:library', file_path: 'notes/field-notes.md' });
    // The digest is of the bytes on disk, not of the in-memory import stamp —
    // otherwise the very next edit would be a spurious `changed_on_disk`.
    expect(rows.find((r) => r.slug === 'field-notes')!.file_digest).toBe(digestOf(fieldNotesBefore));
  });
});
