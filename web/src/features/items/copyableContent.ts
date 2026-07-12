import type { Page } from '../../queries.js';

export type CopyableEntrySource = 'frontmatter';

export interface CopyableEntry {
  label: string;
  value: string;
  source: CopyableEntrySource;
}

const DEFAULT_COPY_LABEL = 'Copy';

export function extractCopyableEntries(page: Pick<Page, 'body_markdown' | 'frontmatter'>): CopyableEntry[] {
  return explicitCopyEntries(page.frontmatter?.['copy']);
}

function explicitCopyEntries(copy: unknown): CopyableEntry[] {
  if (!Array.isArray(copy)) return [];

  return copy.flatMap((entry): CopyableEntry[] => {
    if (!isRecord(entry)) return [];

    const rawValue = entry.value;
    if (typeof rawValue !== 'string') return [];

    const value = rawValue.trim();
    if (!value) return [];

    const rawLabel = entry.label;
    const label = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim() : DEFAULT_COPY_LABEL;
    return [{ label, value, source: 'frontmatter' }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
