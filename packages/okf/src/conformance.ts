import { parse } from '@echozedlabs/codec';
import type { ConformanceIssue, ConformanceReport, OkfBundle } from './types.js';
import { isAttestedComputation, hasComputationSection, validateAttestedComputation } from './attested.js';
import { resolveBundleLinks } from './links.js';

/** Filenames reserved by OKF — never validated as concept documents. */
const RESERVED = new Set(['index.md', 'log.md']);

/**
 * Validate an OKF bundle against the v0.2 conformance rules (spec §11):
 * every non-reserved `.md` file must have parseable frontmatter with a
 * non-empty `type`. Reserved files (`index.md`, `log.md`) are exempt. (The three
 * v0.2 conformance rules are word-for-word the v0.1 §9 rules; the trust/
 * provenance/lifecycle families are all optional and never cause rejection.)
 *
 * This is intentionally strict on the producer side; OKF *consumers* are
 * permissive, but anything we emit should conform.
 *
 * Cross-reference resolution runs alongside it and lands in `report.links`
 * (see {@link resolveBundleLinks}). It is reported, never gated: `conformant`
 * still depends only on the normative rules above, because a bundle that links
 * to a concept in a *different* bundle is valid OKF and the source registry
 * exists precisely so that such bundles coexist.
 *
 * The three-tier report (conformance / policy / advisory) that composes this
 * with the instance's content-model lint lives in `@echozedlabs/content-model`
 * (`validateOkfBundle`) — it must, because this package cannot depend on the
 * content model without creating a cycle.
 */
export function validateBundle(bundle: OkfBundle): ConformanceReport {
  const issues: ConformanceIssue[] = [];
  let conceptCount = 0;

  for (const file of bundle.files) {
    if (!file.path.endsWith('.md')) continue;
    const base = file.path.split('/').pop() ?? file.path;
    if (RESERVED.has(base)) continue;

    conceptCount++;
    const parsed = parse(file.content);
    const frontmatter = (parsed.frontmatter ?? {}) as Record<string, unknown>;
    const type = frontmatter['type'];
    if (typeof type !== 'string' || type.trim() === '') {
      issues.push({
        path: file.path,
        code: 'type.missing',
        severity: 'critical',
        message: 'Concept is missing a non-empty `type` field (OKF v0.2 §11).',
      });
      continue;
    }
    // Attested Computation concepts carry a contract we can shape-check (never execute).
    if (isAttestedComputation(frontmatter)) {
      const { issues: acIssues } = validateAttestedComputation(
        frontmatter,
        file.path,
        hasComputationSection(parsed.body),
      );
      issues.push(...acIssues);
    }
  }

  const conformant = issues.every((i) => i.severity !== 'critical');
  return { conformant, issues, conceptCount, links: resolveBundleLinks(bundle) };
}
