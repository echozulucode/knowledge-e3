import { describe, expect, it } from 'vitest';
import { extractCopyableEntries } from './copyableContent.js';

const basePage = {
  id: 'item_1',
  title: 'Runbook item',
  slug: 'runbook-item',
  body_markdown: 'Long contextual article body.',
  status: 'draft' as const,
  version_token: 1,
  created_at: '2026-05-22T00:00:00.000Z',
  updated_at: '2026-05-22T00:00:00.000Z',
};

describe('extractCopyableEntries', () => {
  it('normalizes explicit frontmatter copy entries with label and value', () => {
    expect(
      extractCopyableEntries({
        ...basePage,
        frontmatter: {
          copy: [
            { label: 'Install command', value: 'pnpm install --frozen-lockfile' },
            { label: 'Run gate', value: 'pnpm -r build && pnpm -r typecheck && pnpm -r test' },
          ],
        },
      }),
    ).toEqual([
      { label: 'Install command', value: 'pnpm install --frozen-lockfile', source: 'frontmatter' },
      { label: 'Run gate', value: 'pnpm -r build && pnpm -r typecheck && pnpm -r test', source: 'frontmatter' },
    ]);
  });

  it('ignores malformed copy entries and trims valid values', () => {
    expect(
      extractCopyableEntries({
        ...basePage,
        frontmatter: {
          copy: [
            { label: 'Missing value' },
            { value: '   ' },
            null,
            'not accepted yet',
            { label: 'CLI', value: '  hermes tools  ' },
          ],
        },
      }),
    ).toEqual([{ label: 'CLI', value: 'hermes tools', source: 'frontmatter' }]);
  });

  it('uses an explicit copy entry instead of the short-command fallback', () => {
    expect(
      extractCopyableEntries({
        ...basePage,
        body_markdown: 'npm test',
        frontmatter: {
          copy: [{ label: 'Preferred command', value: 'pnpm test -- --runInBand' }],
        },
      }),
    ).toEqual([{ label: 'Preferred command', value: 'pnpm test -- --runInBand', source: 'frontmatter' }]);
  });

  it('does not infer copy actions from command-like body content without explicit copy metadata', () => {
    expect(
      extractCopyableEntries({
        ...basePage,
        body_markdown: '```bash\npnpm --filter @echozedlabs/web test\n```',
      }),
    ).toEqual([]);
  });

  it('returns no entries for ordinary long article content without explicit copy metadata', () => {
    expect(
      extractCopyableEntries({
        ...basePage,
        body_markdown: 'This is a longer paragraph with context, references, and more than one idea.\n\nIt should be a preview only.',
      }),
    ).toEqual([]);
  });

  it('preserves multiline commands and special characters from explicit copy metadata exactly', () => {
    const multiline = 'export TOKEN="abc=123" && \\\n  pnpm --filter @echozedlabs/web test:e2e -- --grep "Topic & copy"';

    expect(
      extractCopyableEntries({
        ...basePage,
        frontmatter: {
          copy: [{ label: 'Multiline gate', value: multiline }],
        },
      }),
    ).toEqual([{ label: 'Multiline gate', value: multiline, source: 'frontmatter' }]);
  });

  it('ignores non-array copy metadata instead of rendering a dead copy action', () => {
    expect(
      extractCopyableEntries({
        ...basePage,
        body_markdown: 'pnpm --filter @echozedlabs/server test',
        frontmatter: {
          copy: { label: 'Wrong shape', value: 'do-not-copy' },
        },
      }),
    ).toEqual([]);
  });
});
