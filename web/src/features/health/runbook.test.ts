/**
 * Every runbook pointer names a section that actually exists.
 *
 * This reads the real `docs/operations-runbook.md`, so renaming one of its
 * headings fails here instead of leaving an operator pointed at nothing — which
 * is the failure mode B5 calls out as worse than having no pointer at all.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RUNBOOK, RUNBOOK_DOC, runbookAddress, runbookHint } from './runbook.js';

/**
 * GitHub's heading slugger, as far as these headings exercise it: lower-case,
 * drop everything that is not a word character, a space or a hyphen, then
 * spaces become hyphens. Punctuation the runbook's headings use — `.`, `,`, `/`,
 * an em dash, parentheses, backticks — is dropped, and the double hyphens that
 * leaves behind are real.
 */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
// The runbook is not part of the open-core deliverable yet (it carries cloud
// deployment detail), so in that checkout the file is absent. Skip there rather
// than fail a build that cannot have the doc; the private repo, where the doc
// lives and is edited, is the one that must keep the pointers honest.
const docPath = `${repoRoot}${RUNBOOK_DOC}`;
const doc = existsSync(docPath) ? readFileSync(docPath, 'utf8') : null;

const anchors = new Map<string, string>(
  (doc ?? '')
    .split('\n')
    .filter((line) => /^#{2,4}\s/.test(line))
    .map((line) => line.replace(/^#{2,4}\s+/, ''))
    .map((heading) => [slug(heading), heading]),
);

describe.skipIf(doc === null)('runbook pointers', () => {
  it.each(Object.entries(RUNBOOK))('§%s resolves to a heading in the runbook', (_key, section) => {
    expect(anchors.has(section.anchor)).toBe(true);
  });

  it('shows the title of the heading it points at', () => {
    // An existing anchor is not enough: §3.1's anchor under a §3.7 alert would
    // pass the check above and still send the operator to the wrong page. The
    // displayed title is the heading with its backticks and em dash tidied, so
    // it must slug to the tail of the anchor.
    for (const section of Object.values(RUNBOOK)) {
      expect(section.anchor.endsWith(slug(section.title))).toBe(true);
    }
  });

  it('renders an address a human can paste into an editor or a repository URL', () => {
    expect(runbookAddress(RUNBOOK.reviewHostUnconfigured)).toBe(
      'docs/operations-runbook.md#33-a-change-request-will-not-open--review_host_unconfigured',
    );
    expect(runbookHint(RUNBOOK.mirrorStuck)).toContain('runbook §3.1');
    expect(runbookHint(RUNBOOK.mirrorStuck, 'Capture the rows first.')).toMatch(/^Capture the rows first\./);
  });
});
