import { describe, it, expect } from 'vitest';
import { renderBundleIndex } from '../src/bundle.js';
import { parseBundleIndex } from '../src/import.js';

const entries = [{ path: 'concepts/use-ai.md', title: 'Use AI', description: 'Start here.' }];

describe('bundle-root index presentation round trip', () => {
  it('writes okf_version first, then presentation and start_here, and the landing prose before the concepts', () => {
    const index = renderBundleIndex(entries, {
      bundleTitle: 'MATLAB',
      presentation: 'portal',
      startHere: 'use-ai',
      landingMarkdown: 'Short gateway prose.\n\nSecond paragraph with a [[Link]].',
    });
    expect(index.startsWith('---\nokf_version: "0.2"\npresentation: portal\nstart_here: "use-ai"\n---\n')).toBe(true);
    const prose = index.indexOf('Short gateway prose.');
    expect(prose).toBeGreaterThan(index.indexOf('# MATLAB Index'));
    expect(prose).toBeLessThan(index.indexOf('## Concepts'));
    expect(index).toContain('* [Use AI](/concepts/use-ai.md) - Start here.');

    expect(parseBundleIndex(index)).toEqual({
      presentation: 'portal',
      start_here: 'use-ai',
      landing_markdown: 'Short gateway prose.\n\nSecond paragraph with a [[Link]].',
    });
  });

  it('omits the keys when nothing is set and parses a plain index as empty', () => {
    const index = renderBundleIndex(entries);
    expect(index).not.toContain('presentation:');
    expect(index).not.toContain('start_here:');
    expect(parseBundleIndex(index)).toEqual({});
  });

  it('ignores an unknown presentation value', () => {
    expect(parseBundleIndex('---\nokf_version: "0.2"\npresentation: kiosk\n---\n\n# X Index\n\n## Concepts\n')).toEqual({});
  });
});
