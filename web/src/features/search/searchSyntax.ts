/**
 * What the query language accepts, in the reader's words (reader UX plan §5.7).
 *
 * This mirrors `SUPPORTED_SEARCH_FILTERS` in `@echozedlabs/search`'s query
 * parser — the one table that decides what the parser accepts and what both
 * providers implement. The web does not depend on that package, so the table
 * is restated here, and `searchSyntax.test.ts` reads the parser's source and
 * fails when the two key sets differ: a tip for a key the parser drops would be
 * a lie, and a key with no tip is a feature nobody finds.
 *
 * Both the "Search tips" disclosure on `/search` and the "Searching" section of
 * `/help` render from this table, so they cannot drift from each other either.
 * Anything NOT in it is reported by the server in `warnings`, and `/search`
 * shows them, so a mistyped key is told rather than silently ignored.
 */
export interface FilterHelp {
  /** The key as typed, without the colon. */
  key: string;
  example: string;
  description: string;
  /** The key this one is another spelling of (`space` → `topic`). */
  aliasOf?: string;
}

export const SUPPORTED_FILTER_HELP: FilterHelp[] = [
  { key: 'tag', example: 'tag:mqtt', description: 'Items with that exact tag.' },
  { key: 'category', example: 'category:operations', description: 'Items in that primary category.' },
  { key: 'group', example: 'group:platform-eng', description: 'Items in that tag group.' },
  { key: 'topic', example: 'topic:"Platform Service"', description: 'Items in that Topic, by name or slug.' },
  { key: 'space', example: 'space:platform', description: 'Another spelling of topic:.', aliasOf: 'topic' },
  { key: 'type', example: 'type:Runbook', description: 'Items of that content type.' },
  { key: 'author', example: 'author:"Ada Lovelace"', description: 'Items by that author — the exact name, in any case.' },
  { key: 'updated', example: 'updated:>2026-01-01', description: 'Items last updated in, before or after a date, or within a recent window.' },
  { key: 'is', example: 'is:verified', description: 'Items in that state: verified, unverified, human-reviewed, machine-confirmed, needs-review, draft or published.' },
  { key: 'status', example: 'status:draft', description: 'Drafts you are allowed to see.' },
];

/** How `updated:` reads a date, said once where the tips and help both show it. */
export const UPDATED_FORMS_TIP =
  'updated: takes a year (updated:2026), a month (updated:2026-03) or a day, with >, >=, < or <= for after or before (updated:<=2025-06) — or a recent window: updated:30d, 4w, 6m or 1y.';

export const SEARCH_TIPS: string[] = [
  'Repeat a filter to widen it: tag:mqtt tag:modbus finds either. Different filters narrow: type:Runbook tag:mqtt needs both.',
  'Put a minus in front to exclude: docker -compose, or -tag:legacy.',
  'Quote an exact phrase: "pod disruption budget". Quoted words are matched whole, never as a prefix.',
  'The word you are still typing matches as a prefix, so modb finds Modbus before you finish it.',
  UPDATED_FORMS_TIP,
];
