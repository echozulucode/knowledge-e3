import { parse, type Frontmatter } from '@echozedlabs/codec';
import { stringify } from 'yaml';

export type TitleHeadingSyncReason =
  | 'title-unchanged'
  | 'first-heading-preserved'
  | 'first-heading-differs-from-title'
  | 'no-first-heading';

export interface TitleHeadingSyncResult {
  markdown: string;
  didSync: boolean;
  reason: TitleHeadingSyncReason;
}

export interface BuildItemDraftMarkdownOptions {
  title: string;
  summary?: string;
  body?: string;
  /**
   * A content-type starter scaffold. When present it is used verbatim as the
   * body; any user-typed notes are appended under a `## Notes` section. When
   * absent, the generic Overview/Notes scaffold is used.
   */
  template?: string;
}

function buildRawMarkdown(frontmatter: Frontmatter, body: string): string {
  const yaml = stringify(frontmatter).trim();
  return yaml.length > 0 ? `---\n${yaml}\n---\n${body}` : body;
}

function startsWithMarkdownHeading(markdown: string): boolean {
  return /^#{1,6}\s+\S/.test(markdown.trimStart());
}

export function buildItemDraftMarkdown({ title: _title, summary = '', body = '', template }: BuildItemDraftMarkdownOptions): string {
  const summaryText = summary.trim();
  const bodyText = body.trim();

  // A content type supplies its own structured scaffold; honor it verbatim and
  // fold any user-typed notes in at the end rather than wrapping it in the
  // generic Overview/Notes shape.
  const templateText = template?.trim();
  if (templateText) {
    return bodyText ? [templateText, '', '## Notes', '', bodyText].join('\n') : templateText;
  }

  const bodySection = bodyText
    ? startsWithMarkdownHeading(bodyText)
      ? bodyText
      : ['## Notes', '', bodyText].join('\n')
    : ['## Notes', '', '- Add details here.'].join('\n');

  return [
    '## Overview',
    '',
    summaryText || 'Capture the purpose, context, and next action for this item.',
    '',
    bodySection,
  ].join('\n');
}

export function syncFirstHeadingWithTitle(
  markdown: string,
  previousTitle: string,
  nextTitle: string,
): TitleHeadingSyncResult {
  const parsed = parse(markdown);
  const nextFrontmatter = { ...(parsed.frontmatter as Frontmatter), title: nextTitle } as Frontmatter;

  if (previousTitle === nextTitle) {
    return {
      markdown: buildRawMarkdown(nextFrontmatter, parsed.body),
      didSync: false,
      reason: 'title-unchanged',
    };
  }

  const firstH1Pattern = /(^|\n)# ([^\n]*)(?=\n|$)/;
  const firstH1 = firstH1Pattern.exec(parsed.body);
  if (!firstH1) {
    return {
      markdown: buildRawMarkdown(nextFrontmatter, parsed.body),
      didSync: false,
      reason: 'no-first-heading',
    };
  }

  const headingText = firstH1[2] ?? '';
  if (headingText === previousTitle) {
    return {
      markdown: buildRawMarkdown(nextFrontmatter, parsed.body),
      didSync: false,
      reason: 'first-heading-preserved',
    };
  }

  return {
    markdown: buildRawMarkdown(nextFrontmatter, parsed.body),
    didSync: false,
    reason: 'first-heading-differs-from-title',
  };
}
