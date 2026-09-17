import { UnprocessableEntityException } from '@nestjs/common';
import { validateOkfBundle, type BundleValidationOptions } from '@echozedlabs/content-model';
import type { BundleValidationReport, Diagnostic } from '@echozedlabs/knowledge-types';

/** Filenames OKF reserves. Never concept documents, so never validated as such. */
const RESERVED = new Set(['index.md', 'log.md']);

/**
 * The concept documents of a bundle, in bundle order — the SAME filter
 * `parseBundleFiles` and `validateOkfBundle` apply. They are kept in step
 * deliberately: the import returns its ids in this order, and that positional
 * pairing is how a policy issue on `concepts/orders.md` finds the page it became.
 */
export function conceptPaths(files: { path: string }[]): string[] {
  return files
    .filter((f) => f.path.endsWith('.md') && !RESERVED.has(f.path.split('/').pop() ?? f.path))
    .map((f) => f.path);
}

/**
 * The bundle integrity gate (the product roadmap §7.1). Validates all three tiers
 * and throws when — and only when — the conformance tier carries a `critical`.
 *
 * `summary.conformant` is the sole rejection verdict: it means the input is not
 * an OKF bundle. `summary.meetsPolicy` is this instance's editorial standard and
 * is reported, never enforced. Collapsing the two would let a missing
 * description refuse a perfectly valid bundle, which is the failure this
 * three-tier split exists to prevent.
 *
 * The policy tier is evaluated WITHOUT the instance's tag/category vocabularies.
 * A bundle arrives with its own vocabulary, so linting an import against the
 * terms this instance happens to have seen would flag every term on a first
 * import — noise, not signal. The structural rules (`type`, one primary
 * category, a `description` to publish, parseable frontmatter) are the ones
 * worth recording and they need no context at all. The `validate_okf_bundle`
 * tool can opt into the vocabularies, because a preview may be stricter than a
 * gate; the gate may not.
 */
export function gateBundle(files: { path: string; content: string }[]): BundleValidationReport {
  const report = evaluateGate(files);
  if (!report.summary.conformant) throw bundleNotConformant(report);
  return report;
}

/**
 * Exactly the evaluation {@link gateBundle} makes, returned instead of thrown —
 * the `POST /okf/validate` dry run. One function behind both, so the admin's
 * "Validate" and the import that follows it cannot disagree: a preview that
 * passed a bundle the gate then refused would be worse than no preview.
 *
 * Deliberately not {@link inspectBundle}: that one accepts vocabularies and may
 * be stricter than the gate. This one takes no options because the gate takes
 * none.
 */
export function evaluateGate(files: { path: string; content: string }[]): BundleValidationReport {
  return validateOkfBundle({ files });
}

/** Validate without gating — the `validate_okf_bundle` read path. */
export function inspectBundle(
  files: { path: string; content: string }[],
  ctx: BundleValidationOptions = {},
): BundleValidationReport {
  return validateOkfBundle({ files }, ctx);
}

/**
 * 422, the same status and body shape the content gate's `lint_failed` uses: the
 * request is well-formed and the caller is allowed to make it — the *bundle* is
 * not OKF. 400 would say the caller sent nonsense HTTP; it did not. The whole
 * report travels in the body so the caller can fix the input instead of guessing,
 * and `reason` is the machine-readable discriminator.
 */
export function bundleNotConformant(report: BundleValidationReport): UnprocessableEntityException {
  const { criticalCount, conceptCount } = report.summary;
  return new UnprocessableEntityException({
    message:
      `This is not a conformant OKF bundle: ${criticalCount} critical conformance issue(s) across ` +
      `${conceptCount} concept document(s). Nothing was imported.`,
    reason: 'bundle_not_conformant',
    validation: report,
  });
}

/**
 * Policy issues regrouped per concept file and mapped back onto the `Diagnostic`
 * shape — the shape already stored in `sync_diagnostics.diagnostics_json` and
 * parsed by everything that reads it. `BundleValidationIssue.field` IS the lint's
 * own `Diagnostic.path`; the issue's `path` is the file, so it becomes the map
 * key rather than part of the diagnostic.
 */
export function policyDiagnosticsByPath(report: BundleValidationReport): Map<string, Diagnostic[]> {
  const out = new Map<string, Diagnostic[]>();
  for (const issue of report.policy) {
    // The policy tier never carries `critical` (only conformance does); the
    // guard is what lets the severity narrow to a Diagnostic's.
    if (issue.severity === 'critical') continue;
    const list = out.get(issue.path) ?? [];
    list.push({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      ...(issue.field ? { path: issue.field } : {}),
      ...(issue.fix ? { fix: issue.fix } : {}),
    });
    out.set(issue.path, list);
  }
  return out;
}

/**
 * One line stating the outcome. Defined in `@echozedlabs/content-model` beside the
 * validator so the stdio knowledge-mcp app words the verdict identically; re-exported
 * here so the server's existing imports stay put.
 */
export { bundleSummaryLine } from '@echozedlabs/content-model';
