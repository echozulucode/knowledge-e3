/**
 * Bootstrap deterministic local/demo data.
 *
 * Idempotent: re-running is a no-op for rows that already exist. The exported
 * FIRST_MVP_* fixtures are consumed by first-MVP smoke tests so the UI and MCP
 * paths exercise the same human-readable corpus.
 *
 *   $ DB_URL=./data/kp.sqlite pnpm --filter @echozedlabs/server seed
 */
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { Kysely } from 'kysely';
import { extractItemLinks, parse } from '@echozedlabs/codec';
import { makeKysely } from './db/db.module.js';
import { migrateSqlite } from './db/migrations.js';
import { adminCredentialsFromEnv, seedAdmin as bootstrapAdmin } from './auth/seed-admin.js';
import { newId, nowIso } from './common/ids.js';
import { slugify } from './common/slug.js';
import type { Database } from './db/schema.js';
import { syncTaxonomyInTx, taxonomyFromFrontmatter } from './pages/taxonomy.js';
import { reindexPageFts } from './search/fts-index.js';
import { canonicalTypeLabel } from './content-types/content-types.registry.js';
import { AssetsService } from './images/assets.service.js';
import { descriptorSidecarName } from './images/asset-descriptor.js';
import { PINNED_TOPICS_KEY, SECTIONS_KEY, type PinnedTopicDef, type SectionDef } from './config/config.service.js';
import { extractAssetFiles } from './pages/image-links.js';

export const FIRST_MVP_SEED_SPACES = [
  { slug: 'product', name: 'Product', description: 'First-MVP human product workspace.' },
  { slug: 'agent-notes', name: 'Agent Notes', description: 'First-MVP agent-created drafts and observations.' },
  { slug: 'product-workspace', name: 'Product workspace', description: 'Product planning, packaging, and customer-facing decisions.' },
  { slug: 'research', name: 'Research', description: 'Market, technical, and evidence-gathering notes.' },
  { slug: 'implementation', name: 'Implementation', description: 'Build notes, engineering plans, and delivery details.' },
  { slug: 'operations', name: 'Operations', description: 'Runbooks, maintenance, and recurring workflow notes.' },
  { slug: 'customer-insights', name: 'Customer Insights', description: 'Interview notes, pain points, and user feedback synthesis.' },
  { slug: 'architecture', name: 'Architecture', description: 'System design decisions, tradeoffs, and diagrams.' },
  { slug: 'release-planning', name: 'Release Planning', description: 'Milestones, release readiness, and launch checklists.' },
  { slug: 'personal-knowledge', name: 'Personal Knowledge', description: 'Reusable learning notes and reference material.' },
  { slug: 'automation', name: 'Automation', description: 'Scripts, repeatable workflows, and hands-off task patterns.' },
  { slug: 'integrations', name: 'Integrations', description: 'External services, APIs, and connector-specific notes.' },
  { slug: 'data-modeling', name: 'Data Modeling', description: 'Schemas, metadata conventions, and information architecture.' },
  { slug: 'quality-assurance', name: 'Quality Assurance', description: 'Test plans, validation evidence, and regression coverage.' },
  { slug: 'security-privacy', name: 'Security & Privacy', description: 'Access control, threat notes, and sensitive-data handling.' },
  { slug: 'performance', name: 'Performance', description: 'Latency, scale, profiling, and capacity observations.' },
  { slug: 'support-knowledge', name: 'Support Knowledge', description: 'Troubleshooting guides and user-facing support patterns.' },
  { slug: 'competitive-intel', name: 'Competitive Intel', description: 'Comparable products, positioning, and market observations.' },
  { slug: 'finance-admin', name: 'Finance & Admin', description: 'Pricing, business operations, and lightweight administrative notes.' },
  { slug: 'learning-lab', name: 'Learning Lab', description: 'Experiments, tutorials, and skill-building reference material.' },
] as const;

export const FIRST_MVP_SEED_CATEGORIES = [
  { slug: 'research-notes', name: 'Research notes' },
  { slug: 'draft-capture', name: 'Draft capture' },
  { slug: 'decision-record', name: 'Decision record' },
  { slug: 'how-to', name: 'How-to' },
  { slug: 'reference', name: 'Reference' },
  { slug: 'runbook', name: 'Runbook' },
  { slug: 'experiment', name: 'Experiment' },
  { slug: 'meeting-notes', name: 'Meeting notes' },
] as const;

export const FIRST_MVP_SEED_GROUPS = [
  { slug: 'agent-flow', name: 'agent-flow', spaceSlug: 'product', description: 'Human plus agent happy-path validation group.' },
  { slug: 'demo-review', name: 'demo-review', spaceSlug: 'agent-notes', description: 'Evening-review demo validation group.' },
  { slug: 'editor-ux', name: 'editor-ux', spaceSlug: 'product-workspace', description: 'Composer, editor, and browsing interaction work.' },
  { slug: 'data-entry', name: 'data-entry', spaceSlug: 'product-workspace', description: 'Structured capture and taxonomy entry flow.' },
  { slug: 'onboarding', name: 'onboarding', spaceSlug: 'customer-insights', description: 'First-run user experience and starter content.' },
  { slug: 'roadmap', name: 'roadmap', spaceSlug: 'release-planning', description: 'Planning themes and milestone candidates.' },
  { slug: 'mcp', name: 'mcp', spaceSlug: 'implementation', description: 'MCP integration and agent-facing workflows.' },
  { slug: 'ops-review', name: 'ops-review', spaceSlug: 'operations', description: 'Operational readiness and recurring checks.' },
] as const;

type DemoSeedItem = readonly [
  title: string,
  space: string,
  category: string,
  type: string,
  tags: readonly string[],
  groups: readonly string[],
  description: string,
  bodyDetail: string,
];

/**
 * Each template carries a content `type` (a registry label) and a `category`
 * slug drawn from FIRST_MVP_SEED_CATEGORIES above.
 *
 * "Lint is the migration" (ROADMAP §7.1): the seeded corpus has to satisfy the
 * publish-time rules, or the gate cannot be enforced without bricking the demo
 * data. `type` and `description` are the two error-severity rules this corpus
 * failed on every single item (measured 2026-09-11: 200/200 seeded items failed
 * `type.missing` + `description.missing`; none failed anything about
 * categories). The category slugs were already curated, and now that the
 * publishable vocabulary is the CURATED catalog alone (Eric, 2026-09-11 —
 * issues 97/106) they must stay that way: a slug here that is absent from
 * FIRST_MVP_SEED_CATEGORIES makes its items unpublishable.
 */
const DEMO_ITEM_TEMPLATES = [
  ['Command quick reference', 'how-to', 'How-To', ['commands', 'copyable'], ['editor-ux', 'data-entry'], 'Capture a reusable command with the exact copyable text and surrounding context.'],
  ['Decision tradeoff note', 'decision-record', 'ADR', ['decision', 'tradeoff'], ['roadmap'], 'Record the options considered, selected path, and follow-up questions.'],
  ['Research evidence packet', 'research-notes', 'Concept', ['research', 'evidence'], ['demo-review'], 'Collect quotes, links, and confidence notes for later synthesis.'],
  ['Operational checklist', 'runbook', 'Runbook', ['operations', 'checklist'], ['ops-review'], 'List repeatable steps, verification commands, and escalation triggers.'],
  ['Experiment result log', 'experiment', 'Concept', ['experiment', 'validation'], ['mcp'], 'Summarize the hypothesis, method, result, and next experiment.'],
  ['Reference pattern card', 'reference', 'Architecture Note', ['reference', 'pattern'], ['agent-flow'], 'Document a reusable pattern with examples and adjacent concepts.'],
  ['Meeting capture brief', 'meeting-notes', 'Concept', ['meeting', 'follow-up'], ['onboarding'], 'Capture decisions, owners, and open questions from a focused conversation.'],
  ['Draft idea scratchpad', 'draft-capture', 'Concept', ['idea', 'draft'], ['data-entry'], 'Save a rough idea with enough context to evaluate later.'],
] as const;

const DEMO_SEED_ITEMS: DemoSeedItem[] = Array.from({ length: 98 }, (_, idx) => {
  const topic = FIRST_MVP_SEED_SPACES[idx % FIRST_MVP_SEED_SPACES.length];
  const template = DEMO_ITEM_TEMPLATES[idx % DEMO_ITEM_TEMPLATES.length];
  const cycle = Math.floor(idx / FIRST_MVP_SEED_SPACES.length) + 1;
  const title = `${topic.name} ${template[0]} ${cycle}`;
  const category = template[1];
  const type = template[2];
  const tags = [...template[3], topic.slug, `scale-${String(idx + 1).padStart(3, '0')}`];
  const groups = template[4];
  const description = `${template[5]} Topic: ${topic.name}; sample ${idx + 1} of 98.`;
  const bodyDetail = `This deterministic sample helps validate 100-item browse scale, 20-topic dropdown parity, topic scroll behavior, and mixed metadata density for ${topic.name}.`;
  return [title, topic.name, category, type, tags, groups, description, bodyDetail];
});

/**
 * A minimal PNG encoder: a truecolour PNG is a signature, an IHDR, one
 * deflated IDAT of filter-0 scanlines and an IEND. ~40 lines, and no image
 * dependency for a seed script.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * The generated cover art: one patterned image per seeded topic that carries a
 * cover anywhere, plus one for the seeded series (home plan R2.5, R2.11).
 *
 * The first design review read the previous cover - a flat diagonal gradient -
 * as "a failed image", and it was right: an image with no visible subject is
 * indistinguishable from one that did not load. So each cover is a DELIBERATE
 * motif (stripes, a dot grid, rings, chevrons, steps) in its topic's colour,
 * which reads as art at thumbnail size and at the width of a lead story.
 *
 * Every motif tiles. The same bytes are shown as a square thumbnail on a pinned
 * topic card (`object-fit: cover`, centre crop) and as a 16:9 band on an Updates
 * lead story, and a motif that repeats has no focal point for either crop to cut
 * off. 800x450 is the story's own shape, so the wide crop is the whole image.
 *
 * The colours are the LIGHT-theme values of the `--kp-pin-*` tokens the matching
 * pin uses (`packages/ui/src/tokens.css`), mid-toned so one image sits well on
 * either theme; a tenant who wants a separate dark variant sets `cover_dark`.
 */
type CoverMotif = 'stripes' | 'dots' | 'rings' | 'chevrons' | 'steps';

interface SeedCover {
  motif: CoverMotif;
  rgb: readonly [number, number, number];
}

export const SEED_COVERS = {
  'product-workspace': { motif: 'stripes', rgb: [0x2b, 0x6b, 0x7a] }, // teal
  architecture: { motif: 'dots', rgb: [0x6d, 0x5f, 0x8a] }, // violet
  operations: { motif: 'rings', rgb: [0x8a, 0x54, 0x1f] }, // ochre
  research: { motif: 'chevrons', rgb: [0x3f, 0x7d, 0x5f] }, // green
  'getting-started': { motif: 'steps', rgb: [0x96, 0x56, 0x6e] }, // plum
} as const satisfies Record<string, SeedCover>;

export type SeedCoverKey = keyof typeof SEED_COVERS;

const COVER_WIDTH = 800;
const COVER_HEIGHT = 450;

/**
 * Exact integer square root. `Math.sqrt` alone would almost certainly do, but
 * the whole value of this generator is byte-identical output, so the rounding
 * is corrected in integers rather than trusted.
 */
function isqrt(n: number): number {
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r -= 1;
  while ((r + 1) * (r + 1) <= n) r += 1;
  return r;
}

/** Which of three tones a pixel takes: 0 the ground, 1 the topic colour, 2 the light ink. */
function motifTone(motif: CoverMotif, x: number, y: number): 0 | 1 | 2 {
  switch (motif) {
    case 'stripes': {
      // Diagonal bands with a thin mid-tone edge, so they read as drawn.
      const d = (x + y) % 64;
      return d < 22 ? 2 : d < 27 ? 1 : 0;
    }
    case 'dots': {
      // A staggered (hexagonal) dot grid; every third dot in the mid tone.
      const cell = 50;
      const row = Math.floor(y / cell);
      const shifted = x + (row % 2) * (cell / 2);
      const dx = (shifted % cell) - cell / 2;
      const dy = (y % cell) - cell / 2;
      if (dx * dx + dy * dy > 100) return 0;
      return (row + Math.floor(shifted / cell)) % 3 === 0 ? 1 : 2;
    }
    case 'rings': {
      // Concentric targets on a grid, clipped inside their cell so they never seam.
      const cell = 150;
      const dx = (x % cell) - cell / 2;
      const dy = (y % cell) - cell / 2;
      const r = isqrt(dx * dx + dy * dy);
      if (r > 66) return 0;
      const band = r % 18;
      return band < 6 ? 2 : band < 9 ? 1 : 0;
    }
    case 'chevrons': {
      const v = Math.abs((x % 80) - 40);
      const d = (y + v) % 50;
      return d < 15 ? 2 : d < 20 ? 1 : 0;
    }
    case 'steps': {
      // A staircase of blocks climbing to the right - "getting started" - with a
      // gutter between blocks so each one is distinct.
      const cell = 50;
      if (x % cell < 4 || y % cell < 4) return 0;
      const step = (Math.floor(x / cell) + Math.floor(y / cell)) % 5;
      return step === 0 ? 2 : step === 1 ? 1 : 0;
    }
  }
}

/**
 * Render one seed cover to PNG bytes.
 *
 * The ground darkens the topic colour and brightens slightly towards the lower
 * right, which is what keeps a large flat area from looking like an unloaded
 * frame. All arithmetic is on integers (a division is floored before it is
 * used), so the pixels are the same on every machine.
 */
export function seedCoverPng(key: SeedCoverKey): Buffer {
  const { motif, rgb } = SEED_COVERS[key];
  const dark = rgb.map((c) => Math.floor((c * 55) / 100));
  const light = rgb.map((c) => c + Math.floor(((255 - c) * 62) / 100));
  const span = 2 * (COVER_WIDTH + COVER_HEIGHT);
  const stride = COVER_WIDTH * 3 + 1;
  const raw = Buffer.alloc(COVER_HEIGHT * stride);
  for (let y = 0; y < COVER_HEIGHT; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter type 0 (None)
    for (let x = 0; x < COVER_WIDTH; x += 1) {
      const tone = motifTone(motif, x, y);
      const px = row + 1 + x * 3;
      for (let c = 0; c < 3; c += 1) {
        const ground = dark[c]! + Math.floor(((rgb[c]! - dark[c]!) * (x + y)) / span);
        raw[px + c] = tone === 2 ? light[c]! : tone === 1 ? rgb[c]! : ground;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(COVER_WIDTH, 0);
  ihdr.writeUInt32BE(COVER_HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Bytes, digest and content-addressed filename for a seed cover, computed once
 * per process. Lazily: importing this module (every MCP and OKF suite does, for
 * the corpus fixtures) must not pay for rendering images it never stores.
 */
const coverCache = new Map<SeedCoverKey, { bytes: Buffer; sha256: string; file: string }>();
function seedCover(key: SeedCoverKey): { bytes: Buffer; sha256: string; file: string } {
  let cover = coverCache.get(key);
  if (!cover) {
    const bytes = seedCoverPng(key);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    cover = { bytes, sha256, file: `${sha256.slice(0, 16)}.png` };
    coverCache.set(key, cover);
  }
  return cover;
}

/** The `/assets/<file>` URL a seed cover is served at - stable, because it is content-addressed. */
export function seedCoverUrl(key: SeedCoverKey): string {
  return `/assets/${seedCover(key).file}`;
}

/**
 * The tag the seeded Updates Section filters on, and that the seeded stories
 * carry. Singular because a tag describes one item ("this is an update"), and
 * the word an author types on an item should be the word the reader sees above
 * it (home plan R2.1, R2.9).
 */
export const HOME_UPDATES_TAG = 'update';

/**
 * The company updates the front page leads with.
 *
 * Eric, 2026-09-12: "seed the database to populate the home page accordingly
 * based on the initial seeded content." Before this, `just seed` produced 100
 * items across 20 topics and **nothing the front page reads**: no cross-topic
 * Section, so the news feed fell back to "Recently published", and no pinned
 * topics, so the right-hand column did not render at all. A first-run instance
 * showed the empty-frame state of a page whose whole argument is that it is not
 * an empty frame. (They were "news" until the first design review; Eric renamed
 * the feed Updates, R2.1.)
 *
 * Three properties are deliberate, and a change that loses any of them loses
 * the demonstration:
 *
 * - **Seven topics, not one.** The Updates Section names no topic, and that is the
 *   entire point of it - a feed that spans the instance rather than repeating a
 *   topic landing. Tagging seven stories in one topic would render identically
 *   and prove nothing, so each of these lives somewhere different.
 * - **Explicit, descending `published_at`.** The feed sorts newest-first, so the
 *   order has to be visible on the page: these are dated across four months and
 *   listed here newest first, and `seedFirstMvpCorpus` writes the date into the
 *   `published_at` COLUMN as well as the frontmatter, because that column is
 *   what `sort: 'published'` orders by.
 * - **Publishable as they stand.** `type` is `Blog Post`, which the content
 *   model lints hardest - it requires `published_at` and authors on top of the
 *   universal `description` and one curated category. "Lint is the migration"
 *   (ROADMAP 7.1): seeded content that could not be published through the
 *   product is not a demonstration of the product.
 * - **Covers on some stories, not all** (R2.11). `cover` names a SEED_COVERS
 *   motif, written into the frontmatter as its content-addressed `/assets/` URL.
 *   The lead story has one, so the wide lead card shows it; a few below do and
 *   the rest do not, so the list's no-thumbnail row is on the page too.
 *
 * `space` is the NAME of a topic in FIRST_MVP_SEED_SPACES; the loop resolves it
 * by `slugify(name)`, so every value here must slugify back to a seeded slug.
 */
interface SeedStory {
  title: string;
  space: string;
  category: string;
  author: string;
  publishedAt: string;
  description: string;
  body: string;
  /** A SEED_COVERS key, resolved to its `/assets/` URL when the item is written. */
  cover?: SeedCoverKey;
}

export const FIRST_MVP_SEED_UPDATES: readonly SeedStory[] = [
  {
    title: 'Knowledge Hub is open to every team',
    space: 'Product workspace',
    category: 'decision-record',
    author: 'Dana Okafor',
    publishedAt: '2026-09-08T09:00:00.000Z',
    cover: 'product-workspace',
    description: 'The hub is out of pilot: every team can publish, and every published item is readable without an account.',
    body: 'The pilot ran for a quarter with four teams. Two things settled the decision to open it up: the review queue never grew past a day of work, and readers outside the pilot were already being sent links by hand.',
  },
  {
    title: 'Search is 38% faster after the index rebuild',
    space: 'Performance',
    category: 'experiment',
    author: 'Priya Raman',
    publishedAt: '2026-08-27T14:30:00.000Z',
    description: 'Rebuilding the index from the git working trees cut median search latency from 210ms to 130ms.',
    body: 'The old index had accumulated rows for items that no longer existed. Rebuilding from the working trees is the claim ADR-0001 makes, and measuring it was the only way to find out whether the claim held.',
  },
  {
    title: 'New runbook: restoring a topic from the git mirror',
    space: 'Operations',
    category: 'runbook',
    author: 'Sam Whitfield',
    publishedAt: '2026-08-14T08:15:00.000Z',
    cover: 'operations',
    description: 'Step-by-step recovery for a topic whose index rows were lost, with the verification commands to run afterwards.',
    body: 'Written after the drill, not before it. Every command in it was run against a copy of production, and the expected output is quoted verbatim so you can tell a good run from a bad one.',
  },
  {
    title: 'What 24 interviews told us about how people search',
    space: 'Customer Insights',
    category: 'research-notes',
    author: 'Lena Petrov',
    publishedAt: '2026-07-30T11:00:00.000Z',
    description: 'Readers arrive knowing an answer exists and not what it is called. Navigation is a last resort, not a first move.',
    body: 'Twenty-four sessions, recorded and coded. The clearest finding was also the least comfortable: nobody browsed the topic tree unless search had already failed them.',
  },
  {
    title: 'Private topics now default to closed',
    space: 'Research',
    category: 'decision-record',
    author: 'Marcus Hale',
    publishedAt: '2026-07-11T16:45:00.000Z',
    cover: 'research',
    description: 'A topic marked private is no longer exposed to anonymous visitors anywhere, including the cross-topic feed on the front page.',
    body: 'The gap was narrow and real: a cross-topic Section drew from every topic the viewer could read, and "could read" had not yet been asked of the anonymous visitor. It is asked now, on the server, before the list leaves the building.',
  },
  {
    title: 'Architecture: one canonical file per item',
    space: 'Architecture',
    category: 'reference',
    author: 'Ines Moreau',
    publishedAt: '2026-06-19T10:20:00.000Z',
    description: 'The working tree is the record and the database is a cache of it, which is what makes a rebuild a recovery rather than a migration.',
    body: 'Every item is one Markdown file with frontmatter, in a git working tree. The index is derived. Anything that cannot be reconstructed from the files is, by definition, not part of the record.',
  },
  {
    title: 'Release 0.9: attachments, topic covers, faster landings',
    space: 'Release Planning',
    category: 'reference',
    author: 'Dana Okafor',
    publishedAt: '2026-05-28T13:00:00.000Z',
    description: 'Attachments travel with the bundle, pinned topics can carry a cover image, and topic landings resolve their sections server-side.',
    body: 'The theme of the release is that images are content: they live in the bundle beside the Markdown, they are content-addressed, and a rebuild from git restores them with everything else.',
  },
];

/** The seeded series' slug: what each part's `series` field names, and the Series item's own slug. */
export const SEED_SERIES_SLUG = 'getting-started';

/**
 * A three-part series, so the series page and in-article series navigation are
 * visible on a fresh instance (home plan R2.9 question 2, default yes; R2.11).
 *
 * Two halves, because that is what a series IS in this product:
 *
 * - **The Series item** - content type `series` - is the series' landing page:
 *   `/series/<slug>` reads its title, description and cover. Its title slugifies
 *   to SEED_SERIES_SLUG, which is how the seed loop names every page, so the
 *   item's slug and the parts' `series` field are the same string.
 * - **The parts** are ordinary Blog Posts carrying `series` and `series_order`,
 *   which is all `/feed/series/:slug` orders by. The Series item's hand-written
 *   *Parts* list is prose for a reader of that item, not the source of order.
 *
 * The parts live in three of the topics the seeded updates already use, so the
 * series visibly crosses topics the way the Updates feed does. They are NOT
 * tagged `update`: a series is evergreen guidance rather than something that
 * changed, and they reach a reader through their topics, `/latest` and the
 * series page instead.
 */
export const FIRST_MVP_SEED_SERIES = {
  title: 'Getting started',
  space: 'Product workspace',
  category: 'how-to',
  publishedAt: '2026-09-01T09:00:00.000Z',
  description: 'Three short parts for your first week on the hub: finding an answer, writing one down, and keeping it true.',
  cover: 'getting-started' as SeedCoverKey,
  parts: [
    {
      title: 'Getting started, part 1: Find the answer that already exists',
      space: 'Customer Insights',
      category: 'how-to',
      author: 'Lena Petrov',
      publishedAt: '2026-09-01T10:00:00.000Z',
      description: 'Start with search, not the topic tree: type what you would ask a colleague and let the index do the walking.',
      body: 'Most questions have been answered somewhere already. Search the words you would use out loud, then narrow by topic or type. If nothing turns up, that absence is worth knowing too - it is the cue for part 2.',
    },
    {
      title: 'Getting started, part 2: Write it down once',
      space: 'Architecture',
      category: 'how-to',
      author: 'Ines Moreau',
      publishedAt: '2026-09-02T10:00:00.000Z',
      description: 'Pick a content type, give it a one-line description and a category, and publish: one item, one file, one place to fix it.',
      body: 'Every item is a Markdown file in a git working tree, so what you write is the record. Choose the content type that matches the question - a how-to, a runbook, a decision record - and its template tells you what a reader will look for.',
    },
    {
      title: 'Getting started, part 3: Keep it true',
      space: 'Operations',
      category: 'how-to',
      author: 'Sam Whitfield',
      publishedAt: '2026-09-03T10:00:00.000Z',
      description: 'An item is only useful while it is right: review what you own, and let freshness tell you what to look at next.',
      body: 'Knowledge goes stale quietly. Ask for a review when an item matters, update it when the world changes, and treat a stale badge as a to-do rather than a warning.',
    },
  ] as const satisfies readonly SeedStory[],
} as const;

/**
 * Every seeded item carries `type`, `description`, and exactly one CURATED
 * `categories` entry, so the corpus passes the publish-time lint rather than
 * merely existing. See the note on DEMO_ITEM_TEMPLATES: the seed IS the corpus
 * migration.
 */
export const FIRST_MVP_SEED_ITEMS = [
  {
    title: 'First MVP Retrieval Anchor',
    status: 'published' as const,
    body: 'first mvp retrieval anchor for UI and MCP search. Links to [[First MVP Linked Context]] so backlinks can prove the graph works.',
    tags: ['first-mvp', 'searchable'],
    frontmatter: {
      space: 'Product',
      type: 'Concept',
      description: 'Published product anchor used by the first-MVP happy-path smoke.',
      categories: ['research-notes'],
      groups: ['agent-flow'],
    },
  },
  {
    title: 'First MVP Linked Context',
    status: 'published' as const,
    body: 'Context target for the first MVP smoke. The human-created item links here and should appear as a backlink.',
    tags: ['first-mvp', 'linked'],
    frontmatter: {
      space: 'Agent Notes',
      type: 'Concept',
      description: 'Linked context item used to validate backlinks and link suggestions.',
      categories: ['draft-capture'],
      groups: ['demo-review'],
    },
  },
  ...DEMO_SEED_ITEMS.map(([title, space, category, type, tags, groups, description, bodyDetail], idx) => ({
    title,
    status: idx % 5 === 0 ? 'draft' as const : 'published' as const,
    body: `${description} ${bodyDetail}`,
    tags,
    frontmatter: {
      space,
      type,
      description,
      categories: [category],
      groups,
    },
  })),
  ...FIRST_MVP_SEED_UPDATES.map((entry) => ({
    title: entry.title,
    status: 'published' as const,
    body: entry.body,
    // `update` is the tag HOME_UPDATES_SECTION filters on; the topic slug beside
    // it is the convention the rest of the corpus already follows.
    tags: [HOME_UPDATES_TAG, slugify(entry.space)],
    cover: entry.cover,
    frontmatter: {
      space: entry.space,
      type: 'Blog Post',
      description: entry.description,
      categories: [entry.category],
      groups: [] as string[],
      published_at: entry.publishedAt,
      authors: [entry.author],
    },
  })),
  {
    title: FIRST_MVP_SEED_SERIES.title,
    status: 'published' as const,
    body: [
      '## About this series',
      '',
      FIRST_MVP_SEED_SERIES.description,
      '',
      '## Parts',
      '',
      ...FIRST_MVP_SEED_SERIES.parts.map((part, idx) => `${idx + 1}. [[${part.title}]]`),
    ].join('\n'),
    tags: [SEED_SERIES_SLUG, slugify(FIRST_MVP_SEED_SERIES.space)],
    cover: FIRST_MVP_SEED_SERIES.cover,
    frontmatter: {
      space: FIRST_MVP_SEED_SERIES.space,
      type: 'Series',
      description: FIRST_MVP_SEED_SERIES.description,
      categories: [FIRST_MVP_SEED_SERIES.category],
      groups: [] as string[],
      published_at: FIRST_MVP_SEED_SERIES.publishedAt,
    },
  },
  ...FIRST_MVP_SEED_SERIES.parts.map((part, idx) => ({
    title: part.title,
    status: 'published' as const,
    // No "Part N of M" line in the body: the article's series box says that from
    // the frontmatter, and a hand-written copy would say it twice. The Series
    // item's Parts list still links to each part, so the graph connects them.
    body: part.body,
    tags: [SEED_SERIES_SLUG, slugify(part.space)],
    frontmatter: {
      space: part.space,
      type: 'Blog Post',
      description: part.description,
      categories: [part.category],
      groups: [] as string[],
      published_at: part.publishedAt,
      authors: [part.author],
      series: SEED_SERIES_SLUG,
      series_order: idx + 1,
    },
  })),
] as const;

const DB_URL = process.env['DB_URL'] ?? './data/kp.sqlite';

/**
 * The developer seed's admin. Same implementation as the container's first-run
 * bootstrap (`auth/seed-admin.ts`) — the only difference is the documented
 * local fallback password, which the self-host path deliberately does not have.
 */
function seedAdmin(db: Kysely<Database>): Promise<{ id: string }> {
  const credentials = adminCredentialsFromEnv('admin-dev-password')!;
  // eslint-disable-next-line no-console
  return bootstrapAdmin(db, credentials, (message) => console.log(`[seed] ${message}`));
}

export async function seedFirstMvpCorpus(db: Kysely<Database>, ownerId: string): Promise<{ itemsCreated: number; spaces: number; categories: number; groups: number }> {
  const now = nowIso();
  let itemsCreated = 0;

  for (const space of FIRST_MVP_SEED_SPACES) {
    await db
      .insertInto('spaces')
      .values({
        id: `space_${space.slug}`,
        slug: space.slug,
        name: space.name,
        description: space.description,
        created_at: now,
        updated_at: now,
        archived_at: null,
        visibility: 'public',
      })
      .onConflict((oc) => oc.column('slug').doUpdateSet({ name: space.name, description: space.description, updated_at: now }))
      .execute();
  }

  for (const category of FIRST_MVP_SEED_CATEGORIES) {
    await db
      .insertInto('primary_categories')
      .values({ slug: category.slug, name: category.name, created_at: now, updated_at: now, archived_at: null })
      .onConflict((oc) => oc.column('slug').doUpdateSet({ name: category.name, updated_at: now }))
      .execute();
  }

  for (const group of FIRST_MVP_SEED_GROUPS) {
    const space = await db.selectFrom('spaces').select('id').where('slug', '=', group.spaceSlug).executeTakeFirst();
    await db
      .insertInto('groups')
      .values({
        id: `group_${group.slug}`,
        slug: group.slug,
        name: group.name,
        description: group.description,
        space_id: space?.id ?? null,
        created_at: now,
        updated_at: now,
        archived_at: null,
      })
      .onConflict((oc) => oc.column('slug').doUpdateSet({ name: group.name, description: group.description, space_id: space?.id ?? null, updated_at: now }))
      .execute();
  }

  for (const item of FIRST_MVP_SEED_ITEMS) {
    const existing = await db
      .selectFrom('pages')
      .select('id')
      .where('title', '=', item.title)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (existing) continue;

    const title = item.title;
    const id = newId();
    const versionId = newId();
    const slug = slugify(title);
    // A seed cover is written into the frontmatter as its content-addressed URL,
    // exactly what an author's upload would leave there. The bytes and the
    // `image_links` grant come from `seedCoverImages`, which runs next: this
    // function writes no files, because the MCP and OKF suites call it with no
    // assets directory configured.
    const coverKey = 'cover' in item ? item.cover : undefined;
    const frontmatter = {
      ...item.frontmatter,
      ...(coverKey ? { cover: seedCoverUrl(coverKey) } : {}),
      title,
      status: item.status,
      tags: [...item.tags],
    };
    const raw = markdownWithFrontmatter(frontmatter, item.body);
    const parsed = parse(raw);
    const spaceSlug = slugify(String(item.frontmatter.space));
    const space = await db.selectFrom('spaces').select('id').where('slug', '=', spaceSlug).executeTakeFirst();
    const taxonomy = taxonomyFromFrontmatter(parsed.frontmatter, [...item.tags]);
    // The two derived columns the product's own write path fills in
    // (`PagesService.create`) and this loop, writing rows directly, did not.
    // `type` is what makes a content-type badge render on an index surface, and
    // `published_at` is what `sort: 'published'` orders the front-page feed by:
    // without it the seeded updates are dated in the frontmatter and undated to
    // every query that reads it. Only an EXPLICIT frontmatter date is stamped -
    // the 100 scale-test items carry none and keep a null `published_at`, so
    // they stay behind anything genuinely dated rather than all landing on the
    // seed's own timestamp.
    const publishedAt =
      item.status === 'published' && typeof (parsed.frontmatter as Record<string, unknown>)['published_at'] === 'string'
        ? ((parsed.frontmatter as Record<string, unknown>)['published_at'] as string)
        : null;

    await db.transaction().execute(async (tx) => {
      await tx
        .insertInto('pages')
        .values({
          id,
          slug,
          title,
          status: item.status,
          type: canonicalTypeLabel(String(item.frontmatter.type)),
          published_at: publishedAt,
          owner_id: ownerId,
          space_id: space?.id ?? null,
          created_at: now,
          updated_at: now,
          deleted_at: null,
          version_token: 1,
          current_version_id: versionId,
        })
        .execute();

      await tx
        .insertInto('page_versions')
        .values({
          id: versionId,
          page_id: id,
          body_markdown: parsed.body,
          raw_markdown: raw,
          frontmatter_json: JSON.stringify(parsed.frontmatter),
          parsed_ast_json: JSON.stringify(parsed.ast),
          created_at: now,
          created_by: ownerId,
          parent_version_id: null,
        })
        .execute();

      await syncTaxonomyInTx(tx, id, taxonomy);
      const links = extractItemLinks(parsed);
      if (links.length) {
        await tx.insertInto('item_links').values(links.map((link) => ({ source_page_id: id, target_ref: link.target, link_type: link.type, link_text: link.text, position: link.start }))).execute();
        const wikiLinks = links.filter((link) => link.type === 'wiki');
        if (wikiLinks.length) {
          await tx.insertInto('wikilinks').values(wikiLinks.map((link) => ({ source_page_id: id, target_title: link.target, position: link.start }))).execute();
        }
      }
      await reindexPageFts(tx, id);
    });
    itemsCreated += 1;
  }

  // eslint-disable-next-line no-console
  console.log(`[seed] first-MVP corpus ready (${itemsCreated} new items; ${FIRST_MVP_SEED_SPACES.length} spaces, ${FIRST_MVP_SEED_CATEGORIES.length} categories, ${FIRST_MVP_SEED_GROUPS.length} groups).`);
  return { itemsCreated, spaces: FIRST_MVP_SEED_SPACES.length, categories: FIRST_MVP_SEED_CATEGORIES.length, groups: FIRST_MVP_SEED_GROUPS.length };
}

/**
 * The front page's own configuration: the cross-topic Updates Section and the
 * pinned topics beside it.
 *
 * Two Sections would be wrong here and one is deliberate. The front page leads
 * with the cross-topic Section carrying the LOWEST `order` (the web app's
 * feed-section picker in `features/topic/slots.ts`), and everything else a
 * curator adds renders below the fold, so `order: 0` is the seed claiming the lead and leaving 1, 2, 3 free
 * for whoever configures the instance next.
 *
 * `space` is deliberately absent. That absence IS the feature: a Section
 * naming no topic resolves across every topic the viewer may read
 * (`crossTopicSections`), which is what makes this a front page rather than a
 * second copy of one topic's landing. The seeded stories are spread over seven
 * topics so that property is visible rather than merely configured.
 *
 * The feed's heading on the page is this Section's NAME, so "Updates" is a
 * default a tenant can rename in Admin -> Sections, not a string the page
 * hard-codes (R2.1). An instance seeded before the rename keeps its `News`
 * Section: this key is written only when absent.
 */
export const HOME_UPDATES_SECTION: SectionDef = {
  slug: 'updates',
  name: 'Updates',
  description: 'What we shipped, decided and learned - from every topic in the instance.',
  tags: [HOME_UPDATES_TAG],
  order: 0,
  limit: 12,
};

/** A seeded pin: a `PinnedTopicDef` whose cover is a SEED_COVERS key until the bytes are written. */
type SeedPin = Omit<PinnedTopicDef, 'cover' | 'cover_dark'> & { cover?: SeedCoverKey };

/**
 * The pinned topics: four of the twenty, each with a colour and an icon, and
 * two of them with a generated cover.
 *
 * Covers on SOME pins, deliberately (R2.5): every card has the same thumbnail
 * slot, holding the cover when there is one and the icon on a tint of the
 * colour when there is not, and a fresh instance should show both states side
 * by side - that the two read as the same component is the thing the design
 * review asked for. The icons are `PIN_ICONS` tokens, a closed list like the
 * colours.
 *
 * Four rather than six (the cap) because the point of a pin is that it is a
 * choice - a list that nearly reaches the maximum reads as "all of them" and
 * teaches a new tenant nothing about curating it. The colours are token names,
 * never hex: `PinnedTopicCard` uses them for a 3px rule on the leading edge and
 * an unknown name falls back to the neutral border, so no value here can make
 * the page unreadable.
 */
export const HOME_PINNED_TOPICS: readonly SeedPin[] = [
  { topic: 'product-workspace', color: 'teal', icon: 'compass', cover: 'product-workspace' },
  { topic: 'architecture', color: 'violet', icon: 'diagramProject', cover: 'architecture' },
  { topic: 'operations', color: 'ochre', icon: 'wrench' },
  { topic: 'research', color: 'green', icon: 'bookOpen' },
];

/** Has an operator (or a previous run) already written this key? */
async function hasAppConfig(db: Kysely<Database>, key: string): Promise<boolean> {
  const row = await db.selectFrom('app_config').select('key').where('key', '=', key).executeTakeFirst();
  return !!row;
}

async function putAppConfig(db: Kysely<Database>, key: string, value: unknown, updatedBy: string): Promise<void> {
  await db
    .insertInto('app_config')
    .values({ key, value_json: JSON.stringify(value), updated_at: nowIso(), updated_by: updatedBy })
    .execute();
}

/**
 * Store one generated cover the way an upload would: content-addressed bytes in
 * the bundle's `assets/`, the git-tracked sidecar beside them, and the derived
 * `images` row. Returns the `/assets/<file>` URL, or null if the bytes could
 * not be written (a read-only or unconfigured content root must cost the seed a
 * cover, never the corpus).
 *
 * Why bytes at all, rather than colours only: a pin cover is chrome, embedded
 * in no published item, so `/assets/<file>` serves it to an anonymous visitor
 * only because `isSiteBrandingAsset` consults the registry `ConfigService`
 * primes from the pin list - and a story cover is served only because its
 * published page holds an `image_links` row. Both grants are worth
 * demonstrating, and neither can be demonstrated without bytes.
 *
 * Every step is idempotent: the bytes and the row are keyed by content, and the
 * sidecar is write-once (ADR-0003), so a second run rewrites nothing - not even
 * a `created_at` in a git-tracked file.
 */
async function writeSeedCover(db: Kysely<Database>, ownerId: string, key: SeedCoverKey): Promise<string | null> {
  try {
    const { bytes, sha256, file } = seedCover(key);
    const assets = new AssetsService();
    if (!assets.exists(file)) assets.write(file, bytes);
    const original_filename = `seed-cover-${key}.png`;
    const existing = await db.selectFrom('images').select(['id', 'created_at']).where('sha256', '=', sha256).executeTakeFirst();
    const created_at = existing?.created_at ?? nowIso();
    if (!existing) {
      await db
        .insertInto('images')
        .values({
          id: newId(),
          file,
          mime: 'image/png',
          byte_size: bytes.length,
          sha256,
          alt: null,
          original_filename,
          created_at,
          created_by: ownerId,
        })
        .execute();
    }
    if (!assets.exists(descriptorSidecarName(file))) {
      assets.writeDescriptor({
        schema_version: 1,
        file,
        sha256,
        mime: 'image/png',
        byte_size: bytes.length,
        original_filename,
        alt: null,
        provenance: 'uploaded',
        created_at,
        created_by: ownerId,
      });
    }
    return `/assets/${file}`;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[seed] cover '${key}' not written (${String(err)}); continuing without it.`);
    return null;
  }
}

/**
 * Write every seed cover and grant the seeded items that name one.
 *
 * The corpus loop writes rows directly rather than through `PagesService`, so
 * it never ran `syncImageLinksInTx` - and an `image_links` row is the ONLY thing
 * that makes an asset anonymously readable (`isPubliclyLinked`). Without this
 * pass the seeded stories' covers would 404 for exactly the anonymous reader
 * the feed exists for, until the next server boot happened to run the
 * `backfillCoverImageLinks` migration. The rule is the write path's own:
 * `extractAssetFiles` over the frontmatter's `COVER_FRONTMATTER_KEYS`, and
 * "public" is still decided at read time (published page, non-private topic).
 *
 * Only the seeded titles are visited, and links are only ever added
 * (`onConflict doNothing`): this must never touch an item a person wrote.
 */
export async function seedCoverImages(db: Kysely<Database>, ownerId: string): Promise<{ covers: number; linked: number }> {
  let covers = 0;
  for (const key of Object.keys(SEED_COVERS) as SeedCoverKey[]) {
    if (await writeSeedCover(db, ownerId, key)) covers += 1;
  }

  const titles = FIRST_MVP_SEED_ITEMS.filter((item) => 'cover' in item && item.cover).map((item) => item.title);
  let linked = 0;
  if (titles.length) {
    const rows = await db
      .selectFrom('pages')
      .innerJoin('page_versions', 'page_versions.id', 'pages.current_version_id')
      .select(['pages.id as id', 'page_versions.frontmatter_json as frontmatter_json'])
      .where('pages.title', 'in', titles)
      .where('pages.deleted_at', 'is', null)
      .execute();
    for (const row of rows) {
      const files = extractAssetFiles('', JSON.parse(row.frontmatter_json) as Record<string, unknown>);
      if (files.length === 0) continue;
      const imgs = await db.selectFrom('images').select('id').where('file', 'in', files).execute();
      if (imgs.length === 0) continue;
      const result = await db
        .insertInto('image_links')
        .values(imgs.map((img) => ({ page_id: row.id, image_id: img.id })))
        .onConflict((oc) => oc.doNothing())
        .executeTakeFirst();
      linked += Number(result.numInsertedOrUpdatedRows ?? 0);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[seed] covers ready (${covers} cover(s); ${linked} new cover link(s) on seeded items).`);
  return { covers, linked };
}

/**
 * Make the front page show what it is for.
 *
 * Idempotent in the way that matters for configuration, which is NOT "write the
 * same value again": each key is written only when it is ABSENT. A tenant who
 * has since renamed the Section, retagged it, or unpinned a topic must not have
 * `just seed` undo that - and an empty list is a decision too, so "the key
 * exists" is the test rather than "the list is non-empty".
 *
 * Separate from `seedFirstMvpCorpus` because the corpus is what the MCP and OKF
 * suites build their fixtures on and the presentation config is not: those
 * tests call the corpus function directly and should not acquire a curated
 * front page as a side effect.
 */
export async function seedHomePage(
  db: Kysely<Database>,
  ownerId: string,
): Promise<{ sections: number; pins: number; covers: number }> {
  let sections = 0;
  if (!(await hasAppConfig(db, SECTIONS_KEY))) {
    await putAppConfig(db, SECTIONS_KEY, [HOME_UPDATES_SECTION], ownerId);
    sections = 1;
  }

  let pins = 0;
  let covers = 0;
  if (!(await hasAppConfig(db, PINNED_TOPICS_KEY))) {
    const pinned: PinnedTopicDef[] = [];
    for (const { cover: coverKey, ...pin } of HOME_PINNED_TOPICS) {
      // A cover that could not be written costs the pin its cover, never the
      // pin: the card falls back to its icon in the same slot.
      const cover = coverKey ? await writeSeedCover(db, ownerId, coverKey) : null;
      if (cover) covers += 1;
      pinned.push(cover ? { ...pin, cover } : { ...pin });
    }
    await putAppConfig(db, PINNED_TOPICS_KEY, pinned, ownerId);
    pins = pinned.length;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[seed] home page ready (${sections} section(s), ${pins} pinned topic(s), ${covers} pin cover(s); ` +
      `${sections || pins ? 'written' : 'already configured, left alone'}).`,
  );
  return { sections, pins, covers };
}

function markdownWithFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${formatYamlValue(value)}`)
    .join('\n');
  return `---\n${yaml}\n---\n${body}`;
}

function formatYamlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => formatYamlValue(entry)).join(', ')}]`;
  if (typeof value === 'string') {
    if (/^[\w\-./@:+]+$/.test(value) && !/^(true|false|null|yes|no|~)$/i.test(value) && !/^-?\d/.test(value)) return value;
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return JSON.stringify(value);
}

export async function runSeed(dbUrl = DB_URL) {
  if (dbUrl !== ':memory:') {
    const abs = isAbsolute(dbUrl) ? dbUrl : resolve(process.cwd(), dbUrl);
    mkdirSync(dirname(abs), { recursive: true });
  }

  // eslint-disable-next-line no-console
  console.log(`[seed] DB_URL=${dbUrl}`);
  const db: Kysely<Database> = makeKysely({ url: dbUrl, driver: 'sqlite' });
  try {
    await migrateSqlite(db);
    const { id: adminId } = await seedAdmin(db);
    await seedFirstMvpCorpus(db, adminId);
    await seedCoverImages(db, adminId);
    await seedHomePage(db, adminId);
  } finally {
    await db.destroy();
  }
}

const invokedAsScript = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedAsScript) {
  runSeed().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[seed] failed:', err);
    process.exit(1);
  });
}
