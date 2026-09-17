/**
 * Three-tier bundle audit (inspired by okf-mcp's separated diagnostics).
 *
 * A concept can be non-ideal without being invalid. This layers two advisory
 * tiers on top of the normative conformance check (which stays in
 * {@link validateBundle}), so nothing new here ever rejects a bundle:
 *
 * - **conformance** — the three normative OKF v0.2 rules (§11). Reject on these.
 * - **policy** — Knowledge E3's producer profile (recommended fields). Warn.
 * - **advisories** — v0.2 best-practice (provenance/trust/freshness). Warn.
 */
import { parse } from '@echozedlabs/codec';
import type { ConformanceIssue, OkfBundle, OkfTrustTier } from './types.js';
import { validateBundle } from './conformance.js';
import { trustTier, freshness, okfSignals, type Freshness } from './trust.js';

const RESERVED = new Set(['index.md', 'log.md']);

export interface AuditReport {
  /** True iff there are no critical conformance issues (rejection gate). */
  conformant: boolean;
  conceptCount: number;
  /** Normative OKF v0.2 §11 issues — the only tier that gates conformance. */
  conformance: ConformanceIssue[];
  /** Knowledge E3 producer-profile recommendations (never rejects). */
  policy: ConformanceIssue[];
  /** v0.2 best-practice advisories: provenance, trust, freshness (never rejects). */
  advisories: ConformanceIssue[];
}

export interface AuditOptions {
  /** Date to evaluate `stale_after` against. Defaults to the current date. */
  asOf?: string | Date;
}

/**
 * Audit a bundle across the three tiers. Conformance comes from
 * {@link validateBundle}; policy and advisory tiers are computed per concept.
 */
export function auditBundle(bundle: OkfBundle, opts: AuditOptions = {}): AuditReport {
  const base = validateBundle(bundle);
  const policy: ConformanceIssue[] = [];
  const advisories: ConformanceIssue[] = [];

  for (const file of bundle.files) {
    if (!file.path.endsWith('.md')) continue;
    const baseName = file.path.split('/').pop() ?? file.path;
    if (RESERVED.has(baseName)) continue;

    const fm = (parse(file.content).frontmatter ?? {}) as Record<string, unknown>;
    const type = fm['type'];
    if (typeof type !== 'string' || type.trim() === '') continue; // already a conformance error

    // --- policy: E3 producer profile ---
    if (!isNonEmptyString(fm['title'])) {
      policy.push(
        warn(file.path, 'profile.title.missing', 'Recommended `title` is missing (E3 producer profile).'),
      );
    }
    if (!isNonEmptyString(fm['description'])) {
      policy.push(
        warn(
          file.path,
          'profile.description.missing',
          'Recommended `description` is missing (E3 producer profile).',
        ),
      );
    }

    // --- advisories: v0.2 best-practice ---
    if (!hasActorBy(fm['generated'])) {
      advisories.push(
        warn(
          file.path,
          'provenance.generated.missing',
          'No `generated {by, at}` — provenance of authorship is unknown (§5.2).',
        ),
      );
    }
    if (trustTier(fm) === 'unverified') {
      advisories.push(
        warn(file.path, 'trust.unverified', 'Unverified — no `verified` events; trust tier is the lowest (§5.3).'),
      );
    }
    if (!Array.isArray(fm['sources']) || (fm['sources'] as unknown[]).length === 0) {
      advisories.push(
        warn(file.path, 'provenance.sources.missing', 'No `sources` — the concept records no provenance (§5.1).'),
      );
    }
    if (freshness(fm, opts.asOf) === 'stale') {
      advisories.push(
        warn(
          file.path,
          'lifecycle.stale',
          `Stale — past its \`stale_after\` (${String(fm['stale_after'])}) (§5.5).`,
        ),
      );
    }
  }

  return {
    conformant: base.conformant,
    conceptCount: base.conceptCount,
    conformance: base.issues,
    policy,
    advisories,
  };
}

/** A roll-up of the derived trust/freshness signals across a bundle. */
export interface SignalSummary {
  total: number;
  byTrustTier: Record<OkfTrustTier, number>;
  byFreshness: Record<Freshness, number>;
  withSources: number;
  withGenerated: number;
}

/** Tally the derived signals across every concept in a bundle (for a health view). */
export function summarizeBundleSignals(bundle: OkfBundle, opts: AuditOptions = {}): SignalSummary {
  const summary: SignalSummary = {
    total: 0,
    byTrustTier: { unverified: 0, 'machine-confirmed': 0, 'human-reviewed': 0 },
    byFreshness: { fresh: 0, stale: 0 },
    withSources: 0,
    withGenerated: 0,
  };
  for (const file of bundle.files) {
    if (!file.path.endsWith('.md')) continue;
    const baseName = file.path.split('/').pop() ?? file.path;
    if (RESERVED.has(baseName)) continue;
    const fm = (parse(file.content).frontmatter ?? {}) as Record<string, unknown>;
    const type = fm['type'];
    if (typeof type !== 'string' || type.trim() === '') continue;
    summary.total++;
    const s = okfSignals(fm, opts.asOf);
    summary.byTrustTier[s.trustTier]++;
    summary.byFreshness[s.freshness]++;
    if (s.hasSources) summary.withSources++;
    if (s.generatedBy) summary.withGenerated++;
  }
  return summary;
}

function warn(path: string, code: string, message: string): ConformanceIssue {
  return { path, code, severity: 'warning', message };
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

function hasActorBy(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const by = (value as Record<string, unknown>)['by'];
  return typeof by === 'string' && by.trim() !== '';
}
