import type { Root } from 'mdast';

/**
 * Frontmatter is an arbitrary YAML object. v0.1 typed fields are listed here
 * for autocompletion, but unknown keys are preserved on round-trip.
 */
export interface Frontmatter {
  title?: string;
  status?: 'draft' | 'published';
  tags?: string[];
  owner?: string;
  // Auto-maintained:
  created_at?: string;
  updated_at?: string;
  authors?: string[];
  slug?: string;
  // Anything else.
  [key: string]: unknown;
}

export interface ParsedPage {
  /** Original raw input, unchanged. Used for byte-stable round-trip. */
  raw: string;
  /** Parsed frontmatter object. Unknown keys preserved. */
  frontmatter: Frontmatter;
  /** Body markdown (no frontmatter). */
  body: string;
  /** mdast root for structural manipulation. */
  ast: Root;
  /** True if the input had a frontmatter delimiter block. */
  hasFrontmatter: boolean;
  /** Original frontmatter block including the delimiters, e.g. "---\nfoo: bar\n---\n". */
  rawFrontmatter: string;
  /** Original trailing content after the body (kept for stability). */
  trailing: string;
}

export interface WikiLinkOccurrence {
  /** Title inside the brackets — exact text. */
  target: string;
  /** Byte offset of the opening `[[` in the body. */
  start: number;
  /** Byte offset just past the closing `]]`. */
  end: number;
  /** The full matched text, e.g. "[[Page Title]]". */
  raw: string;
}

export interface ItemLinkOccurrence {
  /** Link syntax family. */
  type: 'wiki' | 'markdown';
  /** Link target reference: wiki title or Markdown href. */
  target: string;
  /** Human-readable link label. */
  text: string;
  /** Byte offset of the link token start in the body. */
  start: number;
  /** Byte offset just past the link token end in the body. */
  end: number;
  /** The full matched/source text for the link token. */
  raw: string;
}

export interface RewriteResult {
  /** New body text with wiki-link tokens rewritten. */
  body: string;
  /** Number of occurrences rewritten. */
  count: number;
  /** Occurrences that were found and rewritten. */
  rewrites: WikiLinkOccurrence[];
}
