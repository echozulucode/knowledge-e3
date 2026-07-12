import { parse } from '@echozedlabs/codec';
import type { ConformanceIssue, ConformanceReport, OkfBundle } from './types.js';

/** Filenames reserved by OKF — never validated as concept documents. */
const RESERVED = new Set(['index.md', 'log.md']);

/**
 * Validate an OKF bundle against the v0.1 conformance rules (spec §9):
 * every non-reserved `.md` file must have parseable frontmatter with a
 * non-empty `type`. Reserved files (`index.md`, `log.md`) are exempt.
 *
 * This is intentionally strict on the producer side; OKF *consumers* are
 * permissive, but anything we emit should conform.
 */
export function validateBundle(bundle: OkfBundle): ConformanceReport {
  const issues: ConformanceIssue[] = [];
  let conceptCount = 0;

  for (const file of bundle.files) {
    if (!file.path.endsWith('.md')) continue;
    const base = file.path.split('/').pop() ?? file.path;
    if (RESERVED.has(base)) continue;

    conceptCount++;
    const frontmatter = parse(file.content).frontmatter as Record<string, unknown>;
    const type = frontmatter?.['type'];
    if (typeof type !== 'string' || type.trim() === '') {
      issues.push({
        path: file.path,
        severity: 'critical',
        message: 'Concept is missing a non-empty `type` field (OKF v0.1 §9).',
      });
    }
  }

  const conformant = issues.every((i) => i.severity !== 'critical');
  return { conformant, issues, conceptCount };
}
