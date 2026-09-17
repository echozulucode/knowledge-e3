/**
 * Series presentation rules (home plan R2.11) — pure, so the series page and
 * the in-article navigation agree on them and they can be unit tested.
 *
 * The order of parts is the server's (`series_order`, then publish date); the
 * Series item's own hand-written *Parts* list is never consulted, because two
 * sources of order will disagree.
 */
import type { SeriesView } from '@echozedlabs/knowledge-types';

/** What a part needs for navigation: enough to link to it and name it. */
export interface SeriesPartLike {
  id: string;
  slug: string;
  title: string;
  reading_time_minutes?: number;
}

export interface SeriesPosition<T extends SeriesPartLike> {
  /** 1-based position in reading order — "Part 2 of 5". */
  number: number;
  total: number;
  previous: T | null;
  next: T | null;
}

/**
 * A slug as a heading: `getting-started` → "Getting started". Sentence case,
 * not title case — it stands in for a title nobody wrote, so it should not
 * pretend to be one.
 */
export function humaniseSlug(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/** The series' display title: the Series item's, else the humanised slug. */
export function seriesTitle(view: Pick<SeriesView, 'series_item'> | null | undefined, slug: string): string {
  return view?.series_item?.title?.trim() || humaniseSlug(slug);
}

/**
 * Where `currentId` sits among `parts`, or null when navigation should not be
 * shown: the item is not one of the (published, visible) parts, or it is the
 * only one — a series of one is not yet a series.
 */
export function seriesPosition<T extends SeriesPartLike>(parts: T[], currentId: string): SeriesPosition<T> | null {
  if (parts.length < 2) return null;
  const index = parts.findIndex((part) => part.id === currentId);
  if (index < 0) return null;
  return {
    number: index + 1,
    total: parts.length,
    previous: parts[index - 1] ?? null,
    next: parts[index + 1] ?? null,
  };
}

/** Sum of the parts' reading times, in whole minutes (a part with no estimate counts as 1). */
export function totalReadingMinutes(parts: Array<Pick<SeriesPartLike, 'reading_time_minutes'>>): number {
  return parts.reduce((sum, part) => sum + Math.max(1, part.reading_time_minutes ?? 1), 0);
}

/** "3 parts · 12 min total" / "1 part · 4 min total". */
export function seriesSummaryLine(parts: Array<Pick<SeriesPartLike, 'reading_time_minutes'>>): string {
  const n = parts.length;
  return `${n} part${n === 1 ? '' : 's'} · ${totalReadingMinutes(parts)} min total`;
}
