/**
 * OKF claim-health eval (inspired by openwiki's LEDGER).
 *
 * Reads the library, exports it as an OKF v0.2 bundle in memory, and scores the
 * *claim health* of every concept: each atomic claim is graded supported / stale /
 * hallucinated / unverified against the concept's `sources` provenance and
 * `stale_after` freshness. Prints a per-concept and an aggregate score, plus the
 * three-tier bundle audit. Read-only — it modifies nothing.
 *
 *   pnpm --filter @echozedlabs/server okf:claim-health
 *   pnpm --filter @echozedlabs/server okf:claim-health --space=physics --asOf=2027-01-01
 *   pnpm --filter @echozedlabs/server okf:claim-health --json
 *
 * The deterministic baseline grades on citation presence only (it can tell cited
 * from uncited, not truth from fiction). To measure real hallucination, wire a
 * source-reading ClaimGrounding into scoreClaimHealth — that is the LEDGER
 * extension point. The self-QA loop (question-finder over source + answer-verifier
 * over the wiki) is the natural companion and is documented in evals/README.md.
 */
import 'reflect-metadata';
import {
  auditBundle,
  buildBundle,
  scoreClaimHealth,
  summarizeBundleSignals,
  type PageInput,
} from '@echozedlabs/okf';
import { parse } from '@echozedlabs/codec';
import { makeKysely } from '../src/db/db.module.js';
import { migrateSqlite } from '../src/db/migrations.js';

const DB_URL = process.env['DB_URL'] ?? './data/kp.sqlite';
const args = process.argv.slice(2);
const asOf = args.find((a) => a.startsWith('--asOf='))?.slice('--asOf='.length);
const spaceArg = args.find((a) => a.startsWith('--space='))?.slice('--space='.length);
const asJson = args.includes('--json');

/* eslint-disable no-console */
async function main(): Promise<void> {
  const db = makeKysely({ url: DB_URL, driver: 'sqlite' });
  try {
    await migrateSqlite(db);
    let query = db
      .selectFrom('pages as p')
      .leftJoin('page_versions as v', 'v.id', 'p.current_version_id')
      .leftJoin('spaces as s', 's.id', 'p.space_id')
      .where('p.deleted_at', 'is', null);
    if (spaceArg?.trim()) {
      const ref = spaceArg.trim();
      query = query.where((eb) => eb.or([eb('s.id', '=', ref), eb('s.slug', '=', ref)]));
    }
    const rows = await query
      .select([
        'p.id as id',
        'p.slug as slug',
        'p.title as title',
        'p.status as status',
        'p.created_at as created_at',
        'p.updated_at as updated_at',
        's.slug as space_slug',
        'v.raw_markdown as raw_markdown',
      ])
      .execute();

    const pages: PageInput[] = rows
      .filter((r) => r.raw_markdown)
      .map((r) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        status: r.status,
        space: r.space_slug ?? null,
        rawMarkdown: r.raw_markdown as string,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));

    const bundle = buildBundle(pages);
    const opts = asOf?.trim() ? { asOf: asOf.trim() } : {};

    let totalClaims = 0;
    let totalSupported = 0;
    const worst: { path: string; score: number; total: number }[] = [];
    for (const file of bundle.files) {
      if (!file.path.startsWith('concepts/') || !file.path.endsWith('.md')) continue;
      const health = scoreClaimHealth(file.content, opts);
      totalClaims += health.total;
      totalSupported += health.supported;
      if (health.total > 0) worst.push({ path: file.path, score: health.score, total: health.total });
    }
    worst.sort((a, b) => a.score - b.score);

    const audit = auditBundle(bundle, opts);
    const signals = summarizeBundleSignals(bundle, opts);
    const aggregate = totalClaims === 0 ? 1 : totalSupported / totalClaims;

    if (asJson) {
      console.log(JSON.stringify({ aggregate, totalClaims, totalSupported, audit, signals, worst: worst.slice(0, 20) }, null, 2));
      return;
    }

    console.log(`\n=== OKF claim-health eval (asOf=${asOf ?? 'today'}) ===`);
    console.log(`concepts: ${signals.total}  claims: ${totalClaims}  aggregate health: ${(aggregate * 100).toFixed(1)}%`);
    console.log(
      `trust: ${signals.byTrustTier['human-reviewed']} human-reviewed · ${signals.byTrustTier['machine-confirmed']} machine · ${signals.byTrustTier.unverified} unverified`,
    );
    console.log(`freshness: ${signals.byFreshness.fresh} fresh · ${signals.byFreshness.stale} stale`);
    console.log(`audit: ${audit.conformance.length} conformance · ${audit.policy.length} policy · ${audit.advisories.length} advisory`);
    console.log('\nlowest claim-health concepts:');
    for (const w of worst.slice(0, 15)) {
      console.log(`  ${(w.score * 100).toFixed(0).padStart(3)}%  (${w.total} claims)  ${w.path}`);
    }
    void parse; // reserved for future source-grounded scoring
  } finally {
    await db.destroy();
  }
}
/* eslint-enable no-console */

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[okf] claim-health failed:', err);
  process.exit(1);
});
