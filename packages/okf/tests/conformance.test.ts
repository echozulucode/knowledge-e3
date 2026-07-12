import { describe, it, expect } from 'vitest';
import { validateBundle } from '../src/conformance.js';
import type { OkfBundle } from '../src/types.js';

describe('validateBundle', () => {
  it('flags a concept missing a type', () => {
    const bundle: OkfBundle = {
      files: [{ path: 'concepts/bad.md', content: '---\ntitle: Bad\n---\n\nNo type.\n' }],
    };
    const report = validateBundle(bundle);
    expect(report.conformant).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.path).toBe('concepts/bad.md');
    expect(report.issues[0]?.severity).toBe('critical');
  });

  it('flags an empty-string type', () => {
    const bundle: OkfBundle = {
      files: [{ path: 'concepts/bad.md', content: '---\ntype: "   "\n---\n\nWhitespace type.\n' }],
    };
    expect(validateBundle(bundle).conformant).toBe(false);
  });

  it('exempts reserved files from the concept type requirement', () => {
    const bundle: OkfBundle = {
      files: [
        { path: 'index.md', content: '---\nokf_version: "0.1"\n---\n\n# Index\n' },
        { path: 'log.md', content: '# Log\n' },
        { path: 'concepts/ok.md', content: '---\ntype: Note\n---\n\nGood.\n' },
      ],
    };
    const report = validateBundle(bundle);
    expect(report.conformant).toBe(true);
    expect(report.conceptCount).toBe(1);
  });

  it('ignores non-markdown files', () => {
    const bundle: OkfBundle = {
      files: [{ path: 'assets/diagram.png', content: 'binary-ish' }],
    };
    const report = validateBundle(bundle);
    expect(report.conformant).toBe(true);
    expect(report.conceptCount).toBe(0);
  });
});
