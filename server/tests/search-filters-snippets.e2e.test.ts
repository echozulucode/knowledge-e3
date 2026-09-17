/**
 * `author:` / `is:` / `updated:` on the real SQLite path, result snippets and
 * highlights, and related/backlink snippets (reader UX plan §5.2, §5.5; issue
 * 114).
 *
 * The exact-set semantics of the three keys are held to
 * `packages/search/src/filter-semantics.ts` by the provider conformance suite;
 * this file covers what only the server has: the REST parameters, Unicode case
 * folding in a stored column, visibility, counts and facets, write paths that
 * keep `page_authors` current, and presentation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { sql, type Kysely } from 'kysely';
import type { INestApplication } from '@nestjs/common';
import type { HighlightRange } from '@echozedlabs/knowledge-types';
import { makeApp, seedAdminAndLogin, seedUserAndLogin } from './helpers.js';
import { KYSELY } from '../src/db/db.module.js';
import type { Database } from '../src/db/schema.js';
import { PagesService, type PageView } from '../src/pages/pages.service.js';
import { backlinkSnippet } from '../src/wiki/wiki.service.js';

interface Hit {
  id: string;
  title: string;
  snippet?: string;
  snippet_truncated?: { start: boolean; end: boolean };
  highlights?: { title?: HighlightRange[]; snippet?: HighlightRange[] };
}

describe('search filters, snippets and highlights', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let pages: PagesService;
  let adminId: string;
  let cookie: string;

  beforeEach(async () => {
    app = await makeApp();
    ({ userId: adminId, cookie } = await seedAdminAndLogin(app));
    db = app.get<Kysely<Database>>(KYSELY);
    pages = app.get(PagesService);
  });
  afterEach(async () => app.close());

  const http = () => request(app.getHttpServer());
  const ADMIN = () => ({ id: adminId, role: 'admin' as const });

  async function page(
    title: string,
    body: string,
    frontmatter: Record<string, unknown> = {},
    opts: { tags?: string[]; status?: 'draft' | 'published'; now?: string; owner?: string } = {},
  ): Promise<PageView> {
    return pages.create(opts.owner ?? adminId, {
      title,
      body,
      status: opts.status ?? 'published',
      tags: opts.tags ?? [],
      frontmatter,
      ...(opts.now ? { now: opts.now } : {}),
    });
  }

  /** `GET /search` as admin (default) or anonymously (`cookie: null`). */
  async function search(query: Record<string, string | string[]>, as: string | null = cookie) {
    let req = http().get('/api/v1/search').query({ limit: '100', ...query });
    if (as) req = req.set('Cookie', as);
    const res = await req.expect(200);
    return res.body as { results: Hit[]; total: number; warnings: string[]; facets: Record<string, { value: string; count: number }[]>; groups: { hits: Hit[] }[] };
  }
  const titles = (body: { results: Hit[] }) => body.results.map((hit) => hit.title).sort();

  describe('author:', () => {
    it('matches the authors list and the single author field, folding non-ASCII case and whitespace', async () => {
      await page('Émilie Notes', 'x', { authors: ['Émilie du Châtelet', 'Voltaire'] }, { tags: ['auth'] });
      await page('Grace Notes', 'x', { author: 'Grace Hopper' }, { tags: ['auth'] });
      await page('Nobody Notes', 'x', {}, { tags: ['auth'] });

      // SQLite's lower() would leave É and Â alone; the stored column is folded in JS.
      expect(titles(await search({ q: 'author:"ÉMILIE   DU CHÂTELET"' }))).toEqual(['Émilie Notes']);
      expect(titles(await search({ q: 'author:voltaire' }))).toEqual(['Émilie Notes']);
      // Exact, not fuzzy: no accent folding, no partial names.
      expect(titles(await search({ q: 'author:"emilie du chatelet"' }))).toEqual([]);
      expect(titles(await search({ q: 'author:grace' }))).toEqual([]);
      expect(titles(await search({ q: 'tag:auth -author:"grace hopper"' }))).toEqual(['Nobody Notes', 'Émilie Notes']);
    });

    it('takes repeatable `author` parameters, which replace author: in the query text', async () => {
      await page('Ada Notes', 'x', { authors: ['Ada Lovelace'] });
      await page('Grace Notes', 'x', { author: 'Grace Hopper' });

      expect(titles(await search({ author: ['Ada Lovelace', 'grace hopper'] }))).toEqual(['Ada Notes', 'Grace Notes']);
      expect(titles(await search({ q: 'author:"Ada Lovelace"', author: 'Grace Hopper' }))).toEqual(['Grace Notes']);
    });

    it('follows edits and deletes through page_authors', async () => {
      const item = await page('Ada Notes', 'x', { authors: ['Ada Lovelace'] });
      await pages.update(ADMIN(), item.id, item.version_token, { title: 'Ada Notes', body: 'x', status: 'published', frontmatter: { authors: ['Mary Somerville'] } });
      expect(titles(await search({ q: 'author:"ada lovelace"' }))).toEqual([]);
      expect(titles(await search({ q: 'author:"mary somerville"' }))).toEqual(['Ada Notes']);

      await pages.softDelete(ADMIN(), item.id);
      const rows = await db.selectFrom('page_authors').selectAll().where('page_id', '=', item.id).execute();
      expect(rows).toEqual([]);
      await pages.restore(ADMIN(), item.id);
      expect(titles(await search({ q: 'author:"mary somerville"' }))).toEqual(['Ada Notes']);
    });

    it('never reaches an item in a private Topic for an anonymous reader', async () => {
      await http().post('/api/v1/topics').set('Cookie', cookie).send({ name: 'Vault', slug: 'vault', visibility: 'private' }).expect(201);
      await page('Vault Notes', 'x', { topic: 'Vault', authors: ['Ada Lovelace'] });
      await page('Open Notes', 'x', { authors: ['Ada Lovelace'] });

      expect(titles(await search({ q: 'author:"Ada Lovelace"' }))).toEqual(['Open Notes', 'Vault Notes']);
      const anon = await search({ q: 'author:"Ada Lovelace"' }, null);
      expect(titles(anon)).toEqual(['Open Notes']);
      expect(anon.total).toBe(1);
      expect(anon.facets['topics']!.map((facet) => facet.value)).not.toContain('vault');
    });
  });

  describe('is: and updated:', () => {
    async function seedTrust(): Promise<void> {
      const verified = (by: string, at: string) => ({ verified: [{ by, at }] });
      await page('Human Checked', 'x', verified('human:ada', '2026-03-01T00:00:00Z'), { tags: ['trust'], now: '2026-03-01T00:00:00.000Z' });
      await page('Machine Checked', 'x', verified('agent:lint', '2026-05-01T00:00:00Z'), { tags: ['trust'], now: '2026-05-01T00:00:00.000Z' });
      await page('Stale And Checked', 'x', { ...verified('human:ada', '2025-01-01T00:00:00Z'), stale_after: '2025-06-01' }, { tags: ['trust'], now: '2025-01-01T00:00:00.000Z' });
      await page('Nobody Checked', 'x', {}, { tags: ['trust'], now: '2026-08-15T00:00:00.000Z' });
    }

    it('applies is: from the query and from repeatable `is` parameters, and counts total and facets with it', async () => {
      await seedTrust();

      expect(titles(await search({ q: 'tag:trust is:verified' }))).toEqual(['Human Checked', 'Machine Checked', 'Stale And Checked']);
      expect(titles(await search({ q: 'tag:trust is:unverified' }))).toEqual(['Nobody Checked']);
      expect(titles(await search({ q: 'tag:trust is:needs-review' }))).toEqual(['Stale And Checked']);
      expect(titles(await search({ q: 'tag:trust -is:needs-review -is:unverified' }))).toEqual(['Human Checked', 'Machine Checked']);

      // What the Trust chips write: repeatable `is`, OR within the key.
      const set = await search({ tag: 'trust', is: ['machine-confirmed', 'unverified'] });
      expect(titles(set)).toEqual(['Machine Checked', 'Nobody Checked']);
      expect(set.total).toBe(2);
      // The Trust facet is counted with its own narrowing lifted, like every
      // other axis, so the chip that widens the search again stays visible.
      expect(Object.fromEntries(set.facets['trust_tiers']!.map((f) => [f.value, f.count]))).toEqual({
        'human-reviewed': 2,
        'machine-confirmed': 1,
        unverified: 1,
      });
      // Tags are NOT lifted: they count the narrowed set.
      expect(set.facets['tags']).toEqual([expect.objectContaining({ value: 'trust', count: 2 })]);

      const bad = await search({ tag: 'trust', is: 'superseded' });
      expect(bad.warnings).toEqual([expect.stringContaining('Unknown is value ignored: superseded')]);
      expect(bad.total).toBe(4);
    });

    it('applies updated: as an instant range from the query and from the `updated` parameter', async () => {
      await seedTrust();
      expect(titles(await search({ q: 'tag:trust updated:2026' }))).toEqual(['Human Checked', 'Machine Checked', 'Nobody Checked']);
      expect(titles(await search({ q: 'tag:trust updated:<2026-05' }))).toEqual(['Human Checked', 'Stale And Checked']);
      const param = await search({ tag: 'trust', updated: '>=2026-05-01', q: 'updated:2025' });
      // The parameter replaces the query's updated:, it does not AND with it.
      expect(titles(param)).toEqual(['Machine Checked', 'Nobody Checked']);
      expect(param.total).toBe(2);
    });

    it('is:draft shows an admin every draft, a user only their own, and an anonymous reader nothing', async () => {
      const { userId, cookie: userCookie } = await seedUserAndLogin(app);
      await page('Admin Draft', 'x', {}, { status: 'draft' });
      await page('User Draft', 'x', {}, { status: 'draft', owner: userId });
      await page('Published', 'x');

      expect(titles(await search({ q: 'is:draft' }))).toEqual(['Admin Draft', 'User Draft']);
      expect(titles(await search({ is: 'draft' }))).toEqual(['Admin Draft', 'User Draft']);
      expect(titles(await search({ q: 'is:draft' }, userCookie))).toEqual(['User Draft']);
      expect(titles(await search({ q: 'is:draft' }, null))).toEqual([]);
      expect(titles(await search({ q: 'status:published is:draft' }))).toEqual([]);
    });
  });

  describe('every free-text term must be satisfied by the item', () => {
    // Regression (gate, 2026-09-13): the taxonomy net ORed per term, so a
    // two-word query returned an item whose Topic name held one of the words.
    async function seed(marker: string) {
      await page(`Scoped Alpha ${marker}`, `${marker} alpha inside the topic`, { topic: 'Scope Topic' });
      await page(`Unscoped Alpha ${marker}`, `${marker} alpha outside the topic`);
      await page('Alpha Sort Anchor', 'Nothing but an anchor.', { topic: 'Alpha Sorted Topic', categories: ['research-notes'] });
      await page(`Marker Only ${marker}`, `${marker} and nothing else`);
      await page('Body Term, Topic Term', `${marker} is in the body`, { topic: 'Quokka Station' });
    }

    it('does not return an item that satisfies only one word through another field, and counts the same', async () => {
      const marker = 'scopemark11789319082663';
      await seed(marker);
      for (const q of [`${marker} alpha`, `alpha ${marker}`, `"${marker}" alpha`]) {
        const set = await search({ q });
        expect({ q, titles: titles(set) }).toEqual({ q, titles: [`Scoped Alpha ${marker}`, `Unscoped Alpha ${marker}`] });
        expect({ q, total: set.total }).toEqual({ q, total: 2 });
        const facetTotal = set.facets['topics']!.reduce((sum, facet) => sum + facet.count, 0);
        expect({ q, facetTotal }).toEqual({ q, facetTotal: 2 });
      }
    });

    it('returns an item whose words are split across its own body and its own Topic name', async () => {
      const marker = 'scopemark22';
      await seed(marker);
      expect(titles(await search({ q: `${marker} quokka` }))).toEqual(['Body Term, Topic Term']);
      // The trailing word as a prefix, still across fields.
      expect(titles(await search({ q: `${marker} quok` }))).toEqual(['Body Term, Topic Term']);
      // …and a word in the Topic name alone still finds it.
      expect(titles(await search({ q: 'quokka' }))).toEqual(['Body Term, Topic Term']);
      // Exclusion still excludes by any field.
      expect(titles(await search({ q: `${marker} -quokka` }))).toEqual([`Marker Only ${marker}`, `Scoped Alpha ${marker}`, `Unscoped Alpha ${marker}`]);
    });
  });

  describe('snippets and highlights', () => {
    const marked = (text: string, ranges: HighlightRange[] = []) => ranges.map(([start, end]) => text.slice(start, end).toLowerCase());

    it('excerpts prose, not Markdown, around the match, and marks it in the title and the snippet', async () => {
      const filler = 'Background paragraph about brokers, retained messages and quality of service levels. '.repeat(6);
      await page(
        'MQTT Broker Setup',
        `# Setup\n\n${filler}\n\nPoint every **gateway** at the [[Broker Sizing|sizing guide]] before you enable the mqtt bridge.\n\n${filler}`,
        { description: 'How to stand up the broker.' },
      );

      const set = await search({ q: 'mqtt gateway' });
      const hit = set.results.find((r) => r.title === 'MQTT Broker Setup')!;
      expect(hit.snippet).toBeTruthy();
      expect(hit.snippet!.length).toBeLessThanOrEqual(200);
      expect(hit.snippet).not.toMatch(/\*\*|\[\[|\]\]|^#|…/);
      expect(hit.snippet).toContain('sizing guide');
      expect(marked(hit.snippet!, hit.highlights?.snippet)).toEqual(['gateway', 'mqtt']);
      expect(marked(hit.title, hit.highlights?.title)).toEqual(['mqtt']);
      expect(hit.snippet_truncated).toEqual({ start: true, end: true });

      // The grouped view the palette renders is the very same hit.
      const grouped = set.groups.flatMap((group) => group.hits).find((r) => r.title === 'MQTT Broker Setup')!;
      expect(grouped.highlights).toEqual(hit.highlights);
      expect(grouped.snippet_truncated).toEqual(hit.snippet_truncated);
    });

    it('marks every term, the trailing prefix word included, in the title and the snippet', async () => {
      const marker = 'scopemark11789319082663';
      await page(`Scoped Alpha ${marker}`, `${marker} alpha inside the topic`);
      for (const q of [`${marker} alpha`, `${marker} alp`]) {
        const set = await search({ q });
        const hit = set.results[0]!;
        // `alpha`/`alp` is the parser's prefixTerm; it must be marked like any other term.
        expect({ q, title: marked(hit.title, hit.highlights?.title) }).toEqual({ q, title: ['alpha', marker] });
        expect({ q, snippet: marked(hit.snippet!, hit.highlights?.snippet) }).toEqual({ q, snippet: [marker, 'alpha'] });
        const grouped = set.groups.flatMap((group) => group.hits)[0]!;
        expect(grouped.highlights).toEqual(hit.highlights);
      }
    });

    it('marks the whole word for a prefix still being typed', async () => {
      await page('Modbus Framing', 'The modbus RTU frame ends with a CRC.');
      const hit = (await search({ q: 'modb' })).results[0]!;
      expect(marked(hit.title, hit.highlights?.title)).toEqual(['modbus']);
      expect(marked(hit.snippet!, hit.highlights?.snippet)).toEqual(['modbus']);
      expect(hit.snippet_truncated).toEqual({ start: false, end: false });
    });

    it('falls back to the description, highlighted, when the body does not say the word', async () => {
      await page('Rotation', 'Use the operator and wait for the job to finish.', { description: 'Rotating a keystore without downtime.' });
      const hit = (await search({ q: 'keystore' })).results[0]!;
      expect(hit.snippet).toBe('Rotating a keystore without downtime.');
      expect(marked(hit.snippet!, hit.highlights?.snippet)).toEqual(['keystore']);
    });

    it('shows the description unhighlighted when FTS matched only through stemming', async () => {
      await page('Certificates', 'The controller keeps renewing certificates before expiry.', { description: 'Automatic TLS lifecycle.' });
      // Quoted, so the word is not also a prefix still being typed (which would
      // literally match `renewing`); FTS5 stems the phrase, the excerpt does not.
      const set = await search({ q: '"renew"' });
      const hit = set.results.find((r) => r.title === 'Certificates')!;
      expect(hit).toBeTruthy();
      expect(hit.snippet).toBe('Automatic TLS lifecycle.');
      expect(hit.highlights).toBeUndefined();
    });

    it('gives a filter-only browse the description, or the opening of the body cut on a word, and no highlights', async () => {
      await page('Described', 'Body.', { description: 'The summary line.' }, { tags: ['browse'] });
      await page('Undescribed', 'word '.repeat(80).trim(), {}, { tags: ['browse'] });
      const set = await search({ tag: 'browse' });
      const byTitle = Object.fromEntries(set.results.map((hit) => [hit.title, hit]));
      expect(byTitle['Described']!.snippet).toBe('The summary line.');
      expect(byTitle['Undescribed']!.snippet!.length).toBeLessThanOrEqual(180);
      expect(byTitle['Undescribed']!.snippet!.endsWith('word')).toBe(true);
      expect(byTitle['Undescribed']!.snippet_truncated).toEqual({ start: false, end: true });
      expect(set.results.every((hit) => hit.highlights === undefined)).toBe(true);
    });
  });

  describe('related and backlink snippets (issue 114)', () => {
    it('cuts readable text around the link, never raw [[…]], on word boundaries', () => {
      const lead = 'An opening paragraph that talks about something else entirely. '.repeat(3);
      const paragraph = `${'Setting the scene with plenty of words before the link appears here. '.repeat(4)}Read [[Getting Started|the onboarding guide]] first, then continue with the rest of the checklist below. ${'More trailing words follow the link for a while. '.repeat(4)}`;
      const body = `${lead}\n\n${paragraph}\n\n${lead}`;
      const position = body.indexOf('[[Getting');

      const text = backlinkSnippet(body, position, 'the onboarding guide', 'Getting Started');
      expect(text).not.toMatch(/\[\[|\]\]/);
      expect(text).toContain('the onboarding guide');
      expect(text.startsWith('…') && text.endsWith('…')).toBe(true);
      const inner = text.slice(1, -1);
      expect(inner.length).toBeLessThanOrEqual(170);
      // Whole words at both edges: the inner text is a run of the paragraph's
      // own readable words.
      const plain = paragraph.replace('[[Getting Started|the onboarding guide]]', 'the onboarding guide').replace(/\s+/g, ' ');
      const at = plain.indexOf(inner);
      expect(at).toBeGreaterThan(0);
      expect(plain[at - 1]).toBe(' ');
      expect(plain[at + inner.length]).toMatch(/[\s.]/);
      // A different paragraph never leaks in.
      expect(text).not.toContain('opening paragraph');
    });

    it('serves readable backlink snippets and hides a private Topic source from an anonymous reader', async () => {
      await http().post('/api/v1/topics').set('Cookie', cookie).send({ name: 'Vault', slug: 'vault', visibility: 'private' }).expect(201);
      const hub = await page('Hub', 'The hub.');
      await page('Open Source', 'See [[Hub]] for context.');
      await page('Vault Source', 'Also [[Hub]] from the vault.', { topic: 'Vault' });

      const admin = await http().get(`/api/v1/pages/${hub.id}/backlinks`).set('Cookie', cookie).expect(200);
      expect(admin.body.backlinks.map((b: { source_title: string; snippet: string }) => [b.source_title, b.snippet]).sort()).toEqual([
        ['Open Source', 'See Hub for context.'],
        ['Vault Source', 'Also Hub from the vault.'],
      ]);
      const anon = await http().get(`/api/v1/pages/${hub.id}/backlinks`).expect(200);
      expect(anon.body.backlinks.map((b: { source_title: string }) => b.source_title)).toEqual(['Open Source']);
    });
  });

  it('writes one page_authors row per distinct normalized author on create', async () => {
    await page('Ada Notes', 'x', { authors: ['Ada Lovelace', 'ADA  LOVELACE'], author: 'Ada Lovelace' });
    const count = await sql<{ n: number }>`SELECT count(*) AS n FROM page_authors`.execute(db);
    expect(Number(count.rows[0]!.n)).toBe(1);
  });
});
