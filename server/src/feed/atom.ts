/**
 * Hand-written Atom 1.0 (RFC 4287) rendering for the blog feeds (plan §3.3).
 * No XML library: the document is a fixed skeleton whose only variable parts
 * are escaped text and attribute values.
 */
import type { FeedEntry } from '@echozedlabs/knowledge-types';

export interface AtomFeedInput {
  /** Stable feed identity, e.g. `urn:e3:feed:latest`. */
  id: string;
  title: string;
  /** Path of this document (rel="self"). */
  selfHref: string;
  /** Path of the HTML page the feed mirrors (rel="alternate"). */
  alternateHref: string;
  updated: string;
  entries: FeedEntry[];
}

export function renderAtom(feed: AtomFeedInput): string {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${esc(feed.id)}</id>`,
    `  <title>${esc(feed.title)}</title>`,
    `  <updated>${esc(feed.updated)}</updated>`,
    `  <link rel="self" type="application/atom+xml" href="${esc(feed.selfHref)}"/>`,
    `  <link rel="alternate" type="text/html" href="${esc(feed.alternateHref)}"/>`,
  ];
  for (const entry of feed.entries) {
    lines.push(
      '  <entry>',
      `    <id>urn:e3:item:${esc(entry.id)}</id>`,
      `    <title>${esc(entry.title)}</title>`,
      `    <link rel="alternate" type="text/html" href="/p/${esc(encodeURIComponent(entry.slug))}"/>`,
      `    <updated>${esc(entry.updated_at)}</updated>`,
    );
    if (entry.published_at) lines.push(`    <published>${esc(entry.published_at)}</published>`);
    for (const name of entry.authors ?? []) lines.push(`    <author><name>${esc(name)}</name></author>`);
    if (entry.description) lines.push(`    <summary>${esc(entry.description)}</summary>`);
    for (const tag of entry.tags ?? []) lines.push(`    <category term="${esc(tag)}"/>`);
    lines.push('  </entry>');
  }
  lines.push('</feed>');
  return `${lines.join('\n')}\n`;
}

/** Escape for both text nodes and double-quoted attribute values. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
