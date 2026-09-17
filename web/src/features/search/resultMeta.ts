/**
 * The one metadata line under a search result (home plan R2.4, applied to
 * search): `Architecture · Runbook · Updated Sep 8`, then — rendered by the row,
 * not here — the trust mark once an item is verified.
 *
 * It replaced a row of chips (topic, "Published", "Title match", "Body match",
 * "Recently updated", then a full locale date) that sat under every result and
 * buried the title. What survives is what a reader uses to choose a result:
 * where it lives, what kind of thing it is, and how old it is. Recency needs no
 * chip of its own — the date says it — and why a result matched is what the
 * snippet above the line already shows.
 *
 * Pure, so the grammar is unit-tested rather than eyeballed. The date is the
 * home feed's `shortDate`, so search and the feed never disagree on how a day
 * is written.
 */
import { shortDate } from '../home/storyMeta.js';

export interface ResultMetaInput {
  /** The topic's display name, as the search API sends it. */
  topic?: string | null;
  /** Content-type label; text here, never a chip. */
  type?: string | null;
  updatedAt?: string | null;
}

/** The text parts of a result's metadata line, present only when known. */
export function resultMetaParts({ topic, type, updatedAt }: ResultMetaInput, { now, locale }: { now?: Date; locale?: string } = {}): string[] {
  const parts: string[] = [];
  const topicName = topic?.trim();
  if (topicName) parts.push(topicName);
  const kind = type?.trim();
  if (kind) parts.push(kind);
  const date = shortDate(updatedAt, now, locale);
  if (date) parts.push(`Updated ${date}`);
  return parts;
}
