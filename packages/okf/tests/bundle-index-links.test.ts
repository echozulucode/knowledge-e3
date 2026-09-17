/**
 * Curated landing-page links (`links:` in the bundle-root `index.md`).
 *
 * The point of putting them here rather than in the host's configuration is
 * that they travel with the content: committed to the same repository, restored
 * by a rebuild-from-git, and carried by a backup. That only holds if they
 * round-trip through the index file, which is what this asserts.
 */
import { describe, it, expect } from 'vitest';
import { renderBundleIndex } from '../src/bundle.js';
import { parseBundleIndex } from '../src/import.js';
import type { BundleLink } from '../src/types.js';

const entries = [{ path: 'concepts/use-ai.md', title: 'Use AI' }];

describe('bundle-root index curated links', () => {
  it('round-trips labels, in-app routes, external hrefs and descriptions in authored order', () => {
    const links: BundleLink[] = [
      { label: 'Onboarding checklist', to: '/p/onboarding' },
      { label: 'Sections', to: '/sections', description: 'Everything we curate: by slot' },
      { label: 'Tool request form', href: 'https://intranet.example/tools/request' },
    ];
    const index = renderBundleIndex(entries, { presentation: 'portal', links });
    expect(index).toContain('links:\n  - label: "Onboarding checklist"\n    to: "/p/onboarding"\n');
    // A label with a colon must survive: it is quoted, so YAML does not read it
    // as a nested mapping.
    expect(index).toContain('    description: "Everything we curate: by slot"');

    const parsed = parseBundleIndex(index);
    expect(parsed.presentation).toBe('portal');
    expect(parsed.links).toEqual(links);
  });

  it('emits no links key when there are none, and parses an index without one as having none', () => {
    const index = renderBundleIndex(entries, { links: [] });
    expect(index).not.toContain('links:');
    expect(parseBundleIndex(index).links).toBeUndefined();
    expect(parseBundleIndex(renderBundleIndex(entries)).links).toBeUndefined();
  });

  it('drops a malformed entry and keeps the rest, so one typo cannot cost the page its links', () => {
    const index = [
      '---',
      'okf_version: "0.2"',
      'links:',
      '  - label: "No destination"',
      '  - to: "/sections"', // no label
      '  - label: "Both"',
      '    to: "/sections"',
      '    href: "https://example.test"',
      '  - label: "Protocol relative"',
      '    to: "//evil.example/x"',
      '  - label: "Script"',
      '    href: "javascript:alert(1)"',
      '  - "just a string"',
      '  - label: "Good one"',
      '    to: "/latest"',
      '---',
      '',
      '# X Index',
      '',
      '## Concepts',
      '',
    ].join('\n');
    expect(parseBundleIndex(index).links).toEqual([{ label: 'Good one', to: '/latest' }]);
  });

  it('ignores a links value that is not a sequence', () => {
    expect(parseBundleIndex('---\nokf_version: "0.2"\nlinks: "/sections"\n---\n\n# X\n\n## Concepts\n').links).toBeUndefined();
  });

  it('truncates an absurd list rather than rendering hundreds of links', () => {
    const many = Array.from({ length: 40 }, (_, i) => `  - label: "L${i}"\n    to: "/p/x${i}"`).join('\n');
    const parsed = parseBundleIndex(`---\nokf_version: "0.2"\nlinks:\n${many}\n---\n\n# X\n\n## Concepts\n`);
    expect(parsed.links).toHaveLength(24);
    expect(parsed.links?.[0]).toEqual({ label: 'L0', to: '/p/x0' });
  });
});
