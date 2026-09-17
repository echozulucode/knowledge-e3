/**
 * The bundle integrity + lint gate (the product roadmap §7.1): one report that
 * keeps "this is not an OKF bundle" and "this does not meet our standards" apart.
 *
 * It is composed *here* rather than in `@echozedlabs/okf` because of the package
 * layering: content-model depends on okf, so only this side can see both the
 * format rules and the instance's content rules. The reverse dependency would be
 * a cycle, which is also why okf's conformance check knows nothing about the
 * content-type registry or the lint.
 *
 * Tier assignment, and the reasoning behind each:
 *  - **conformance** ← `validateBundle().issues`. The normative OKF v0.2 rules
 *    (§11) plus the Attested Computation contract (§10.2). Only `critical` here
 *    blocks an import.
 *  - **policy** ← `lint()` per concept. This instance's editorial rules. An
 *    `error` means the content is below local standards — never a reason to
 *    refuse an otherwise valid OKF bundle.
 *  - **advisory** ← `validateBundle().links` plus `auditBundle()`'s v0.2
 *    trust/provenance/freshness advisories. Cross-bundle references are
 *    legitimate, so unresolved links live here rather than in conformance.
 *
 * `auditBundle`'s own *policy* tier (the E3 producer profile: recommended
 * `title`/`description`) is deliberately NOT folded in: the content-model lint is
 * this instance's policy, and including both would report the same missing
 * description twice under two different rule ids.
 */
import { auditBundle, validateBundle, type AuditOptions, type OkfBundle } from '@echozedlabs/okf';
import type {
  BundleValidationIssue,
  BundleValidationReport,
  BundleValidationSummary,
} from '@echozedlabs/knowledge-types';
import { lint, type LintOptions } from './lint.js';

/** Filenames reserved by OKF — exempt from every tier, as they are from conformance. */
const RESERVED = new Set(['index.md', 'log.md']);

export type BundleValidationOptions = LintOptions & AuditOptions;

/**
 * Validate an OKF bundle across all three tiers.
 *
 * @param ctx the {@link LintContext} the policy tier lints against (known
 *   categories/tags, `now`), plus `asOf` for the freshness advisories.
 */
export function validateOkfBundle(
  bundle: OkfBundle,
  ctx: BundleValidationOptions = {},
): BundleValidationReport {
  const conformanceReport = validateBundle(bundle);
  const audit = auditBundle(bundle, ctx);

  const conformance: BundleValidationIssue[] = conformanceReport.issues.map((i) => ({
    path: i.path,
    code: i.code,
    severity: i.severity,
    message: i.message,
  }));

  // A concept the format itself rejects gets no policy opinion: linting a file
  // that has no `type` only restates the conformance failure in another tier.
  const rejected = new Set(
    conformanceReport.issues.filter((i) => i.severity === 'critical').map((i) => i.path),
  );

  const policy: BundleValidationIssue[] = [];
  for (const file of bundle.files) {
    if (!file.path.endsWith('.md')) continue;
    if (RESERVED.has(basename(file.path))) continue;
    if (rejected.has(file.path)) continue;

    for (const d of lint(file.content, ctx)) {
      // Link resolution is decided bundle-wide by okf against every concept in
      // the bundle; the lint's single-document view of it would double-report.
      if (d.code === 'link.unresolved') continue;
      policy.push({
        path: file.path,
        code: d.code,
        severity: d.severity,
        message: d.message,
        ...(d.path ? { field: d.path } : {}),
        ...(d.fix ? { fix: d.fix } : {}),
      });
    }
  }

  const advisory: BundleValidationIssue[] = [
    ...conformanceReport.links.map((l) => ({
      path: l.path,
      code: l.code,
      severity: 'warning' as const,
      message: l.message,
      target: l.target,
      ...(l.field ? { field: l.field } : {}),
    })),
    ...audit.advisories.map((a) => ({
      path: a.path,
      code: a.code,
      severity: 'warning' as const,
      message: a.message,
    })),
  ];

  const criticalCount = conformance.filter((i) => i.severity === 'critical').length;
  const policyErrorCount = policy.filter((i) => i.severity === 'error').length;
  const summary: BundleValidationSummary = {
    conceptCount: conformanceReport.conceptCount,
    conformant: criticalCount === 0,
    meetsPolicy: policyErrorCount === 0,
    conformanceCount: conformance.length,
    policyCount: policy.length,
    advisoryCount: advisory.length,
    criticalCount,
    policyErrorCount,
  };

  return { conformance, policy, advisory, summary };
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * One line stating the outcome, for a log or an agent that wants prose. The two
 * verdicts are named separately on purpose: "would be refused" and "would be
 * accepted and flagged" are different outcomes, and a caller that cannot tell
 * them apart will treat a style warning as a broken bundle.
 *
 * Lives beside {@link validateOkfBundle} so every host that runs the validator
 * (the server's REST and MCP doors, the stdio knowledge-mcp app) words the
 * verdict identically.
 */
export function bundleSummaryLine(report: BundleValidationReport): string {
  const s = report.summary;
  const advisory = s.advisoryCount > 0 ? ` ${s.advisoryCount} advisory note(s).` : '';
  if (!s.conformant) {
    return (
      `Not an OKF bundle: ${s.criticalCount} critical conformance issue(s) across ${s.conceptCount} ` +
      `concept document(s). An import would be refused whole — nothing would be written.${advisory}`
    );
  }
  if (!s.meetsPolicy) {
    return (
      `Conformant OKF (${s.conceptCount} concept document(s)) but ${s.policyErrorCount} policy error(s): ` +
      `an import would be ACCEPTED and the failures recorded as content diagnostics.${advisory}`
    );
  }
  return (
    `Conformant OKF and meets policy: ${s.conceptCount} concept document(s), ` +
    `${s.conformanceCount} conformance and ${s.policyCount} policy note(s), none blocking.${advisory}`
  );
}
