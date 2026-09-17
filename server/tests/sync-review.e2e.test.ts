/**
 * Review policy (plan §8.2 `review`, §12) e2e: in a source whose mode is
 * `review` a save never touches the base branch. The file and the index are
 * written first, then the file is committed to a per-item branch, pushed, and a
 * change request is opened **once** through the source's `ChangeRequestHost`;
 * the item stays a draft (`display_state: in-review`) and the working-tree copy
 * goes back to the base-branch version. Merging the change request upstream is
 * what finally publishes the item, through the normal inbound indexer.
 *
 * The origin is a temp bare repo; the host is the real `GitHubHost` adapter over
 * an injected `fetchImpl` (no network). The registry's remote is a GitHub URL —
 * which the adapter must be able to parse — rewritten to the temp bare repo by a
 * repo-local `url.<path>.insteadOf` so git still pushes locally.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { FetchImpl } from '@echozedlabs/repo-sync';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { actorFrom } from '../src/content/actor.js';
import { ContentCommandsService } from '../src/content/content-commands.service.js';
import { PagesService } from '../src/pages/pages.service.js';
import { ReviewService } from '../src/sync/review.service.js';
import { REVISION_MIRROR } from '../src/storage/revision-mirror.port.js';
import { RoutingRevisionMirror } from '../src/storage/routing-revision-mirror.adapter.js';
import { SourceRegistryService } from '../src/sync/source-registry.service.js';
import { SyncService } from '../src/sync/sync.service.js';
import { SpacesService } from '../src/taxonomy/spaces.service.js';

const GITHUB_REMOTE = 'https://github.com/acme/kb.git';
const PR_URL = 'https://github.com/acme/kb/pull/12';
const TOKEN_ENV = 'E3_TEST_REVIEW_TOKEN';

interface HostCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function hasRef(dir: string, ref: string): boolean {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--verify', '-q', ref], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function fileOnRef(dir: string, ref: string, path: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'show', `${ref}:${path}`], { encoding: 'utf8' });
  } catch {
    return null;
  }
}

describe('sync: review policy (item branches + change requests) e2e', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let sync: SyncService;
  let registry: SourceRegistryService;
  let pages: PagesService;
  let content: ContentCommandsService;
  let spaces: SpacesService;
  let cookie: string;
  let userId: string;
  let tmp: string;
  let root: string;
  let bare: string;
  let local: string;
  let calls: HostCall[];
  let prState: 'open' | 'merged' | 'closed';

  const openChangeCalls = (): number =>
    calls.filter((c) => c.method === 'POST' && c.url.endsWith('/pulls')).length;
  const commentCalls = (): number => calls.filter((c) => c.url.endsWith('/comments')).length;

  /** The real GitHub adapter, driven by canned responses instead of the network. */
  const fetchImpl: FetchImpl = async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    });
    if (method === 'POST' && url.endsWith('/pulls')) {
      return new Response(JSON.stringify({ number: 12, html_url: PR_URL, state: 'open', merged: false }), { status: 201 });
    }
    if (method === 'GET' && /\/pulls\/12$/.test(url)) {
      return new Response(
        JSON.stringify({ number: 12, html_url: PR_URL, state: prState === 'open' ? 'open' : 'closed', merged: prState === 'merged' }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 200 });
  };

  /** A bare origin with one commit on `main`. */
  function seedOrigin(): void {
    bare = join(tmp, 'origin.git');
    const seed = join(tmp, 'seed');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
    execFileSync('git', ['clone', '-q', bare, seed]);
    git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(seed, 'config', 'user.email', 'upstream@example.com');
    git(seed, 'config', 'user.name', 'Upstream');
    writeFileSync(join(seed, 'README.md'), '# Ops\n', 'utf8');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'seed');
    git(seed, 'push', '-q', 'origin', 'main');
  }

  /**
   * The working tree the server will use, already on `main` with `origin` set to
   * the GitHub URL the host adapter parses — rewritten to the bare repo locally.
   */
  function seedWorkingTree(): void {
    local = join(root, 'topics', 'ops');
    mkdirSync(local, { recursive: true });
    execFileSync('git', ['init', '-q', '--initial-branch=main', local]);
    git(local, 'config', 'user.email', 'knowledge-e3@localhost');
    git(local, 'config', 'user.name', 'Knowledge E3');
    git(local, 'config', `url.${bare.replace(/\\/g, '/')}.insteadOf`, GITHUB_REMOTE);
    git(local, 'remote', 'add', 'origin', GITHUB_REMOTE);
    git(local, 'fetch', '-q', 'origin');
    git(local, 'reset', '--hard', 'origin/main');
  }

  /** A reviewer's clone that can fast-forward `main` or push someone else's edit. */
  function reviewerClone(name: string): string {
    const dir = join(tmp, name);
    execFileSync('git', ['clone', '-q', bare, dir]);
    git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(dir, 'config', 'user.email', 'reviewer@example.com');
    git(dir, 'config', 'user.name', 'Reviewer');
    return dir;
  }

  async function registerSource(mode: 'direct' | 'review'): Promise<void> {
    await registry.upsert('topic:ops', {
      remote_url: GITHUB_REMOTE,
      branch: 'main',
      role: 'authoritative',
      mode,
      host_kind: 'github',
      host_base_url: 'https://api.github.test',
      host_token_env: TOKEN_ENV,
    });
  }

  async function registerReviewSource(): Promise<void> {
    await spaces.create({ name: 'Ops' });
    await registerSource('review');
  }

  /**
   * The state a proposed removal has to start from: an item whose file really
   * is on the base branch, because it was authored while the source was
   * `direct`, then deleted once the source turned `review`. The row is gone
   * from the index immediately and the change request carries the intent.
   */
  async function stagedRemoval(): Promise<{ id: string; path: string; branch: string }> {
    await spaces.create({ name: 'Ops' });
    await registerSource('direct');
    const created = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({
        title: 'Checklist',
        body: 'the checklist\n',
        status: 'published',
        frontmatter: { topic: 'Ops', type: 'Concept', categories: ['guides'], description: 'Ops checklist.' },
      })
      .expect(201);
    const id = created.body.page.id as string;
    await app.get<RoutingRevisionMirror>(REVISION_MIRROR).flush();

    await registerSource('review');
    await request(app.getHttpServer()).delete(`/api/v1/pages/${id}`).set('Cookie', cookie).expect(204);
    const row = await db.selectFrom('pages').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.deleted_at).not.toBeNull();
    expect(row.review_state).toBe('open');
    return { id, path: 'concepts/checklist.md', branch: row.review_branch! };
  }

  const declinedQueue = async (): Promise<{ count: number; items: { id: string }[] }> => {
    const res = await request(app.getHttpServer()).get('/api/v1/admin/health/content').set('Cookie', cookie).expect(200);
    return res.body.queues.declined_removal_still_deleted;
  };

  async function createChecklist(): Promise<{ id: string; slug: string; version_token: number; review: { state: string; url: string; branch: string } }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({
        title: 'Checklist',
        body: 'draft one\n',
        status: 'draft',
        frontmatter: { topic: 'Ops', type: 'Concept', categories: ['guides'], description: 'Ops checklist.' },
      })
      .expect(201);
    return res.body.page;
  }

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'e3-sync-review-'));
    root = join(tmp, 'wiki');
    process.env['GIT_MIRROR_ROOT'] = root;
    process.env[TOKEN_ENV] = 'test-token';
    calls = [];
    prState = 'open';
    seedOrigin();
    seedWorkingTree();
    app = await makeApp();
    ({ cookie, userId } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
    sync = app.get(SyncService);
    registry = app.get(SourceRegistryService);
    pages = app.get(PagesService);
    content = app.get(ContentCommandsService);
    spaces = app.get(SpacesService);
    app.get(ReviewService).fetchImpl = fetchImpl;
    // The lint requires exactly one KNOWN primary category.
    await spaces.createCategory({ name: 'Guides' });
  });

  afterEach(async () => {
    await app.close();
    delete process.env['GIT_MIRROR_ROOT'];
    delete process.env[TOKEN_ENV];
    rmSync(tmp, { recursive: true, force: true });
  });

  it('stages a create on an item branch, keeps the base branch clean, and opens exactly one change request', async () => {
    await registerReviewSource();
    const page = await createChecklist();

    expect(page.review).toMatchObject({ state: 'open', url: PR_URL });
    expect(page.review.branch).toMatch(/^e3\/checklist-/);
    const branch = page.review.branch;

    // The base branch never saw the file: not in the working tree, not in its log.
    expect(existsSync(join(local, 'concepts', 'checklist.md'))).toBe(false);
    expect(git(local, 'log', '--oneline', '--', 'concepts/checklist.md')).toBe('');
    expect(git(local, 'status', '--porcelain')).toBe('');
    expect(fileOnRef(bare, 'main', 'concepts/checklist.md')).toBeNull();

    // The item branch on origin carries exactly one commit, with the file.
    expect(git(bare, 'rev-list', '--count', `main..${branch}`)).toBe('1');
    expect(fileOnRef(bare, branch, 'concepts/checklist.md')).toContain('draft one');

    // …opened once, with the item title and a body that names the item.
    expect(openChangeCalls()).toBe(1);
    const opened = calls.find((c) => c.method === 'POST' && c.url.endsWith('/pulls'))!;
    expect(opened.url).toBe('https://api.github.test/repos/acme/kb/pulls');
    expect(opened.body).toMatchObject({ title: 'Checklist', head: branch, base: 'main' });
    expect(String(opened.body!['body'])).toContain('/p/checklist');
    expect(String(opened.body!['body'])).toContain('Content lint:');

    // The item reads as a draft in review, and the index kept the edited content.
    const view = await request(app.getHttpServer()).get(`/api/v1/items/${page.id}`).set('Cookie', cookie).expect(200);
    expect(view.body.item).toMatchObject({ status: 'draft', display_state: 'in-review' });
    expect(view.body.item.review).toMatchObject({ state: 'open', url: PR_URL, branch });
    expect(view.body.item.body_markdown).toContain('draft one');

    // The outbox row the index wrote is marked processed by the branch push.
    const outbox = await db
      .selectFrom('content_outbox')
      .selectAll()
      .where('page_id', '=', page.id)
      .execute();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.processed_at).toBeTruthy();
  });

  it('adds later saves to the same branch without opening a second change request', async () => {
    await registerReviewSource();
    const page = await createChecklist();
    const branch = page.review.branch;

    await request(app.getHttpServer())
      .put(`/api/v1/pages/${page.id}`)
      .set('Cookie', cookie)
      .set('If-Match', String(page.version_token))
      .send({ body: 'draft two\n' })
      .expect(200);

    expect(git(bare, 'rev-list', '--count', `main..${branch}`)).toBe('2');
    expect(fileOnRef(bare, branch, 'concepts/checklist.md')).toContain('draft two');
    expect(openChangeCalls()).toBe(1);
    // Still nothing on the base branch, and the working tree is clean.
    expect(existsSync(join(local, 'concepts', 'checklist.md'))).toBe(false);
    expect(git(local, 'status', '--porcelain')).toBe('');
    const after = (await pages.getById(page.id))!;
    expect(after.status).toBe('draft');
    expect(after.review).toMatchObject({ state: 'open', branch });
  });

  it('publishes the item when the change request merges, and prunes the item branch', async () => {
    await registerReviewSource();
    const page = await createChecklist();
    const branch = page.review.branch;

    // `publish` in a review source stages instead of flipping status; `reviewed`
    // still appends the OKF verification to the staged file.
    await content.publish(actorFrom({ id: userId, username: 'admin', role: 'admin' }, 'rest'), page.id, { reviewed: true });
    expect(openChangeCalls()).toBe(1);
    const staged = fileOnRef(bare, branch, 'concepts/checklist.md')!;
    expect(staged).toContain('status: published');
    expect(staged).toContain('verified:');
    expect((await pages.getById(page.id))!.status).toBe('draft');

    // A reviewer merges the item branch into main upstream…
    const reviewer = reviewerClone('reviewer');
    git(reviewer, 'fetch', '-q', 'origin', branch);
    git(reviewer, 'push', '-q', 'origin', 'FETCH_HEAD:refs/heads/main');
    prState = 'merged';

    // …and the next cycle notices, merges locally, indexes the merged file.
    await sync.runNow('topic:ops');

    const merged = (await pages.getById(page.id))!;
    expect(merged.status).toBe('published');
    expect(merged.review).toMatchObject({ state: 'merged', url: PR_URL, branch });
    expect(merged.review!.closed_at).toBeTruthy();
    expect(merged.body_markdown).toContain('draft one');
    // The item branch is gone from origin and the file is now on the base branch.
    expect(hasRef(bare, `refs/heads/${branch}`)).toBe(false);
    expect(existsSync(join(local, 'concepts', 'checklist.md'))).toBe(true);

    // No longer in review: the display state goes back to the lifecycle one.
    const view = await request(app.getHttpServer()).get(`/api/v1/items/${page.id}`).set('Cookie', cookie).expect(200);
    expect(view.body.item.display_state).not.toBe('in-review');
  });

  it('records a closed change request and leaves the item a draft', async () => {
    await registerReviewSource();
    const page = await createChecklist();
    prState = 'closed';

    await sync.runNow('topic:ops');

    const after = (await pages.getById(page.id))!;
    expect(after.status).toBe('draft');
    expect(after.review).toMatchObject({ state: 'closed' });
    expect(after.review!.closed_at).toBeTruthy();
    // The base branch still never saw the file.
    expect(fileOnRef(bare, 'main', 'concepts/checklist.md')).toBeNull();
    // A declined EDIT is untouched by the issue-96 restore: the item was never
    // deleted, so there is nothing to bring back and nothing to report.
    const row = await db.selectFrom('pages').selectAll().where('id', '=', page.id).executeTakeFirstOrThrow();
    expect(row.deleted_at).toBeNull();
    expect((await declinedQueue()).count).toBe(0);
  });

  it('restores a declined removal from the BASE-BRANCH file, not from the deleted row', async () => {
    const { id, path } = await stagedRemoval();

    // Somebody edited the file on the base branch while the change request sat
    // open. This is the whole point of re-reading rather than re-rendering: the
    // deleted row still holds "the checklist", so a restore built from the row
    // would write this edit away.
    const edited = fileOnRef(local, 'main', path)!.replace('the checklist', 'edited upstream');
    writeFileSync(join(local, path), edited, 'utf8');
    git(local, 'commit', '-q', '-a', '-m', 'upstream edit');

    prState = 'closed';
    await sync.runNow('topic:ops');

    const restored = await pages.getById(id);
    expect(restored).not.toBeNull();
    expect(restored!.body_markdown).toContain('edited upstream');
    expect(restored!.body_markdown).not.toContain('the checklist');
    expect(restored!.status).toBe('published');
    const row = await db.selectFrom('pages').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.deleted_at).toBeNull();
    expect(row.review_state).toBe('closed');
    expect(row.review_closed_at).toBeTruthy();
    // The file stayed exactly where it was; nothing was written back to it.
    expect(git(local, 'status', '--porcelain').trim()).toBe('');
    expect(fileOnRef(local, 'main', path)).toBe(edited);
    // Restored, so nothing for an admin to chase.
    expect((await declinedQueue()).count).toBe(0);
  });

  it('restores a declined removal once, however many cycles run', async () => {
    const { id } = await stagedRemoval();
    prState = 'closed';

    await sync.runNow('topic:ops');
    await sync.runNow('topic:ops');

    const rows = await db.selectFrom('pages').selectAll().where('slug', '=', 'checklist').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.deleted_at).toBeNull();
    expect(rows[0]!.review_state).toBe('closed');
  });

  it('still deletes when the removal MERGES', async () => {
    const { id, path, branch } = await stagedRemoval();

    // The reviewer merges the removal branch, so the deletion reaches base.
    const reviewer = reviewerClone('reviewer');
    git(reviewer, 'fetch', '-q', 'origin', branch);
    git(reviewer, 'push', '-q', 'origin', 'FETCH_HEAD:refs/heads/main');
    prState = 'merged';
    await sync.runNow('topic:ops');

    expect(await pages.getById(id)).toBeNull();
    const row = await db.selectFrom('pages').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.deleted_at).not.toBeNull();
    expect(row.review_state).toBe('merged');
    // The file is gone from the base branch and from the working tree, and no
    // untracked leftover was put back.
    expect(fileOnRef(local, 'main', path)).toBeNull();
    expect(existsSync(join(local, path))).toBe(false);
    expect(git(local, 'status', '--porcelain').trim()).toBe('');
    // A merged removal is not a divergence, so it raises no health row either.
    expect((await declinedQueue()).count).toBe(0);
  });

  it('raises a Content-health row when a declined removal cannot be restored', async () => {
    const { id, path } = await stagedRemoval();

    // The file is gone from the base branch too — somebody removed it there
    // directly — so there is nothing left to restore the item from.
    rmSync(join(local, path));
    git(local, 'commit', '-q', '-a', '-m', 'removed on base');

    prState = 'closed';
    await sync.runNow('topic:ops');

    const row = await db.selectFrom('pages').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.deleted_at).not.toBeNull();
    expect(row.review_state).toBe('closed');

    const queue = await declinedQueue();
    expect(queue.count).toBe(1);
    expect(queue.items[0]).toMatchObject({ id, slug: 'checklist', title: 'Checklist', review: { state: 'closed', url: PR_URL } });
  });

  it('answers 503 review_host_unconfigured AFTER the file and the index were written', async () => {
    await registerReviewSource();
    delete process.env[TOKEN_ENV];

    const res = await request(app.getHttpServer())
      .post('/api/v1/pages')
      .set('Cookie', cookie)
      .send({
        title: 'Checklist',
        body: 'draft one\n',
        status: 'published',
        frontmatter: { topic: 'Ops', type: 'Concept', categories: ['guides'], description: 'Ops checklist.' },
      })
      .expect(503);
    expect(res.body).toMatchObject({ reason: 'review_host_unconfigured', source_id: 'topic:ops' });

    // The author's content survived: file on disk, row in the index, still a draft.
    const saved = (await pages.getBySlug('checklist'))!;
    expect(saved).toMatchObject({ title: 'Checklist', status: 'draft' });
    expect(saved.body_markdown).toContain('draft one');
    expect(saved.review).toBeNull();
    expect(existsSync(join(local, 'concepts', 'checklist.md'))).toBe(true);
    expect(openChangeCalls()).toBe(0);
  });

  it('reports an inbound lint failure on the change request the file came from, once', async () => {
    await registerReviewSource();
    const page = await createChecklist();
    const branch = page.review.branch;

    const reviewer = reviewerClone('reviewer');
    const pushBad = (body: string, message: string): void => {
      mkdirSync(join(reviewer, 'concepts'), { recursive: true });
      writeFileSync(
        join(reviewer, 'concepts', 'checklist.md'),
        `---\ntitle: Checklist\ne3_id: ${page.id}\nstatus: published\n---\n\n${body}\n`,
        'utf8',
      );
      git(reviewer, 'add', '-A');
      git(reviewer, 'commit', '-q', '-m', message);
      git(reviewer, 'push', '-q', 'origin', 'main');
    };

    // A file with no type and no primary category fails the lint. It arrives on
    // the base branch (the reviewer pushed it) while the change request is open.
    pushBad('Untyped and uncategorized.', 'reviewer edit');
    await sync.runNow('topic:ops');
    expect(commentCalls()).toBe(1);
    const comment = calls.find((c) => c.url.endsWith('/comments'))!;
    expect(comment.url).toBe('https://api.github.test/repos/acme/kb/issues/12/comments');
    expect(String(comment.body!['body'])).toContain('concepts/checklist.md');

    // A second failing version does not produce a second comment.
    git(reviewer, 'pull', '-q', '--ff-only', 'origin', 'main');
    pushBad('Still untyped.', 'reviewer edit 2');
    await sync.runNow('topic:ops');
    expect(commentCalls()).toBe(1);
    expect((await pages.getById(page.id))!.status).toBe('draft');
    expect(branch).toMatch(/^e3\/checklist-/);
  });

  it('carries the change request through the search and feed paths, not just the item view', async () => {
    await registerReviewSource();
    const page = await createChecklist();
    const branch = page.review.branch;

    // Search (the `KnowledgeQuery` seam the palette and browse read through):
    // the staged item is still a draft, so an admin asks for drafts.
    const searched = await request(app.getHttpServer())
      .get('/api/v1/search')
      .query({ q: 'Checklist', include_drafts: 'true' })
      .set('Cookie', cookie)
      .expect(200);
    const hit = searched.body.results.find((r: { id: string }) => r.id === page.id);
    expect(hit).toBeTruthy();
    expect(hit.review).toMatchObject({ state: 'open', url: PR_URL, branch });
    expect(hit.display_state).toBe('in-review');
    // …and the grouped view references the same enriched hits.
    const grouped = searched.body.groups.flatMap((g: { hits: { id: string; display_state?: string }[] }) => g.hits);
    expect(grouped.find((h: { id: string }) => h.id === page.id)?.display_state).toBe('in-review');

    // Merging upstream publishes the item (the staged file carries the publish
    // intent); the feed summary then carries the settled change request and the
    // ordinary lifecycle display state.
    await content.publish(actorFrom({ id: userId, username: 'admin', role: 'admin' }, 'rest'), page.id);
    const reviewer = reviewerClone('reviewer');
    git(reviewer, 'fetch', '-q', 'origin', branch);
    git(reviewer, 'push', '-q', 'origin', 'FETCH_HEAD:refs/heads/main');
    prState = 'merged';
    await sync.runNow('topic:ops');
    expect((await pages.getById(page.id))!.status).toBe('published');

    // The default feed carries blog types only; this item is a Concept.
    const feed = await request(app.getHttpServer()).get('/api/v1/feed?types=Concept').set('Cookie', cookie).expect(200);
    const entry = feed.body.items.find((e: { id: string }) => e.id === page.id);
    expect(entry).toBeTruthy();
    expect(entry.review).toMatchObject({ state: 'merged', url: PR_URL, branch });
    expect(entry.display_state).not.toBe('in-review');
  });

  it('lists, refreshes and merges reviews over the admin API', async () => {
    await registerReviewSource();
    const page = await createChecklist();
    const branch = page.review.branch;

    const listed = await request(app.getHttpServer()).get('/api/v1/admin/sources/topic:ops/reviews').set('Cookie', cookie).expect(200);
    expect(listed.body.reviews).toHaveLength(1);
    expect(listed.body.reviews[0]).toMatchObject({ page_id: page.id, state: 'open', url: PR_URL, branch });

    const refreshed = await request(app.getHttpServer())
      .post(`/api/v1/admin/sources/topic:ops/reviews/${page.id}/refresh`)
      .set('Cookie', cookie)
      .expect(200);
    expect(refreshed.body.review).toMatchObject({ state: 'open' });

    // Merging through the host: the adapter PUTs the merge, the reconcile that
    // follows sees `merged` (the reviewer's ref move stands in for the host's).
    const reviewer = reviewerClone('reviewer');
    git(reviewer, 'fetch', '-q', 'origin', branch);
    git(reviewer, 'push', '-q', 'origin', 'FETCH_HEAD:refs/heads/main');
    prState = 'merged';
    const merged = await request(app.getHttpServer())
      .post(`/api/v1/admin/sources/topic:ops/reviews/${page.id}/merge`)
      .set('Cookie', cookie)
      .expect(200);
    expect(merged.body.review).toMatchObject({ page_id: page.id, state: 'merged' });
    expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/pulls/12/merge'))).toBe(true);
    expect(hasRef(bare, `refs/heads/${branch}`)).toBe(false);
  });
});
