/**
 * Mirror health e2e (issue 88): the git-mirror failure mode has to leave
 * evidence. A `content_outbox` row left `processed_at IS NULL` past the
 * threshold — and any `revision_mirror_state` carrying an error or stuck dirty
 * — must show up on Admin → Health → Content, including the reported shape
 * where the page never got a `revision_mirror_state` row at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import { makeApp, seedAdminAndLogin } from './helpers.js';
import { PagesService } from '../src/pages/pages.service.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { MIRROR_STUCK_MS } from '../src/content-health/mirror-health.js';

const HOUR_MS = 60 * 60 * 1000;

describe('mirror health (/admin/health/content → mirror) e2e', () => {
  let app: INestApplication;
  let cookie: string;
  let adminId: string;
  let pages: PagesService;
  let db: Kysely<Database>;

  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  async function makePage(title: string): Promise<string> {
    const page = await pages.create(adminId, { title, body: 'x', status: 'published', frontmatter: { type: 'Concept' } });
    return page.id;
  }

  async function enqueue(row: {
    id: string;
    page_id: string;
    created_at: string;
    processed_at?: string | null;
    error?: string | null;
    file_path?: string | null;
    source_id?: string | null;
  }): Promise<void> {
    await db
      .insertInto('content_outbox')
      .values({
        id: row.id,
        page_id: row.page_id,
        source_id: row.source_id ?? 'main',
        file_path: row.file_path ?? 'concepts/x.md',
        file_digest: 'sha256:deadbeef',
        actor_id: adminId,
        kind: 'upsert',
        created_at: row.created_at,
        processed_at: row.processed_at ?? null,
        error: row.error ?? null,
      })
      .execute();
  }

  async function mirrorState(row: {
    page_id: string;
    dirty?: number;
    error?: string | null;
    updated_at: string;
    path?: string | null;
    last_commit?: string | null;
  }): Promise<void> {
    await db
      .insertInto('revision_mirror_state')
      .values({
        page_id: row.page_id,
        backend: 'git',
        path: row.path ?? 'concepts/x.md',
        last_synced_version_token: 1,
        last_commit: row.last_commit ?? null,
        last_ref: null,
        dirty: row.dirty ?? 0,
        error: row.error ?? null,
        created_at: row.updated_at,
        updated_at: row.updated_at,
        last_synced_at: null,
      })
      .execute();
  }

  const report = async () =>
    (await request(app.getHttpServer()).get('/api/v1/admin/health/content').set('Cookie', cookie).expect(200)).body;

  beforeEach(async () => {
    app = await makeApp();
    ({ cookie, userId: adminId } = await seedAdminAndLogin(app));
    pages = app.get(PagesService);
    db = app.get<Kysely<Database>>(KYSELY);
  });
  afterEach(async () => app.close());

  it('reports nothing when every outbox row was processed and every mirror is clean', async () => {
    const id = await makePage('Committed');
    await enqueue({ id: 'ob-done', page_id: id, created_at: iso(HOUR_MS), processed_at: iso(HOUR_MS - 1000) });
    await mirrorState({ page_id: id, updated_at: iso(HOUR_MS - 1000), last_commit: 'abc123' });

    const body = await report();
    expect(body.mirror.stuck_after_ms).toBe(MIRROR_STUCK_MS);
    expect(body.mirror.pending).toEqual({ count: 0, items: [] });
    expect(body.mirror.mirror_errors).toEqual({ count: 0, items: [] });
  });

  it('lists a pending row older than the threshold with the details needed to act on it', async () => {
    const id = await makePage('Stuck Concept');
    await enqueue({
      id: 'ob-stuck',
      page_id: id,
      created_at: iso(HOUR_MS),
      file_path: 'concepts/stuck-concept.md',
      source_id: 'main',
      error: 'commit failed: index.lock',
    });
    await mirrorState({ page_id: id, dirty: 1, error: 'commit failed: index.lock', updated_at: iso(HOUR_MS) });

    const { mirror } = await report();
    expect(mirror.pending.count).toBe(1);
    const [item] = mirror.pending.items;
    expect(item).toMatchObject({
      outbox_id: 'ob-stuck',
      page_id: id,
      slug: 'stuck-concept',
      title: 'Stuck Concept',
      kind: 'upsert',
      source_id: 'main',
      file_path: 'concepts/stuck-concept.md',
      error: 'commit failed: index.lock',
      mirror_state: 'error',
      mirror_error: 'commit failed: index.lock',
    });
    expect(item.age_seconds).toBeGreaterThanOrEqual(3500);
    expect(Date.parse(item.created_at)).toBeLessThan(Date.now() - MIRROR_STUCK_MS);
  });

  it('does not report a row that is still within the threshold', async () => {
    const id = await makePage('Just Written');
    await enqueue({ id: 'ob-fresh', page_id: id, created_at: iso(1000) });

    const { mirror } = await report();
    expect(mirror.pending.count).toBe(0);
    expect(mirror.pending.items).toEqual([]);
  });

  it('includes a pending row whose page has NO revision_mirror_state row — the reported failure', async () => {
    const id = await makePage('Never Mirrored');
    await enqueue({ id: 'ob-orphan', page_id: id, created_at: iso(HOUR_MS), file_path: 'concepts/never-mirrored.md' });
    // Deliberately no revision_mirror_state row: an inner join would drop this.

    const { mirror } = await report();
    expect(mirror.pending.count).toBe(1);
    expect(mirror.pending.items[0]).toMatchObject({
      outbox_id: 'ob-orphan',
      page_id: id,
      slug: 'never-mirrored',
      mirror_state: 'missing',
      mirror_error: null,
      last_commit: null,
    });
  });

  it('surfaces mirror errors and long-dirty mirrors even when the outbox row was processed', async () => {
    const errored = await makePage('Errored Mirror');
    const dirty = await makePage('Long Dirty Mirror');
    const freshDirty = await makePage('Recently Dirty Mirror');
    await enqueue({ id: 'ob-1', page_id: errored, created_at: iso(HOUR_MS), processed_at: iso(HOUR_MS - 1000) });
    await mirrorState({ page_id: errored, dirty: 0, error: 'fatal: could not read Username', updated_at: iso(HOUR_MS), path: 'concepts/errored-mirror.md' });
    await mirrorState({ page_id: dirty, dirty: 1, updated_at: iso(HOUR_MS) });
    // Dirty, but only for a moment — a commit in flight, not a stuck mirror.
    await mirrorState({ page_id: freshDirty, dirty: 1, updated_at: iso(1000) });

    const { mirror } = await report();
    expect(mirror.mirror_errors.count).toBe(2);
    const byPage = Object.fromEntries(
      (mirror.mirror_errors.items as { page_id: string }[]).map((i) => [i.page_id, i]),
    );
    expect(byPage[errored]).toMatchObject({
      slug: 'errored-mirror',
      title: 'Errored Mirror',
      path: 'concepts/errored-mirror.md',
      dirty: false,
      error: 'fatal: could not read Username',
    });
    expect(byPage[dirty]).toMatchObject({ slug: 'long-dirty-mirror', dirty: true, error: null });
    expect(byPage[freshDirty]).toBeUndefined();
    expect(byPage[errored].age_seconds).toBeGreaterThanOrEqual(3500);
    // The processed outbox row is not double-reported as pending.
    expect(mirror.pending.count).toBe(0);
  });

  it('still lists a stuck row for a soft-deleted page', async () => {
    const id = await makePage('Deleted Since');
    await enqueue({ id: 'ob-gone', page_id: id, created_at: iso(HOUR_MS), file_path: 'concepts/deleted-since.md' });
    // A deletion still owes git a commit, so the pending row must not be filtered out.
    await db.updateTable('pages').set({ deleted_at: iso(0) }).where('id', '=', id).execute();

    const { mirror } = await report();
    expect(mirror.pending.count).toBe(1);
    expect(mirror.pending.items[0]).toMatchObject({
      outbox_id: 'ob-gone',
      page_id: id,
      slug: 'deleted-since',
      file_path: 'concepts/deleted-since.md',
      mirror_state: 'missing',
    });
  });
});
