/**
 * Pure helpers for topic landing pages (plan §3.1–3.2): the fixed slot order a
 * portal renders, and which topic is the site's home topic.
 */
import type { PresentationProfile, SectionSlot, SectionView } from '@echozedlabs/knowledge-types';

/** Portal slot order; `start-here` is rendered as the Get started button, not a list. */
export const PORTAL_SLOT_ORDER: SectionSlot[] = ['essential', 'examples', 'limitations', 'latest', 'advanced'];

export const SLOT_HEADINGS: Record<SectionSlot, string> = {
  'start-here': 'Start here',
  essential: 'Essential guidance',
  examples: 'Examples / What worked',
  limitations: 'Known limitations',
  latest: 'Latest',
  advanced: 'Advanced',
  none: '',
};

export const SLOT_OPTIONS: SectionSlot[] = ['none', 'start-here', 'essential', 'examples', 'limitations', 'advanced', 'latest'];

export const PRESENTATION_OPTIONS: PresentationProfile[] = ['wiki', 'portal', 'blog', 'docs'];

/** A portal section with the heading it renders under. */
export interface SlottedSection {
  section: SectionView;
  heading: string;
}

function byOrderThenName(a: SectionView, b: SectionView): number {
  return (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name);
}

/**
 * Portal order: one entry per slot in `PORTAL_SLOT_ORDER` (several sections
 * sharing a slot keep their `order`), then unslotted sections by `order` under
 * their own names. `start-here` sections are not listed.
 */
export function orderPortalSections(sections: SectionView[]): SlottedSection[] {
  const out: SlottedSection[] = [];
  for (const slot of PORTAL_SLOT_ORDER) {
    for (const s of sections.filter((x) => x.slot === slot).sort(byOrderThenName)) {
      out.push({ section: s, heading: SLOT_HEADINGS[slot] });
    }
  }
  for (const s of sections.filter((x) => !x.slot || x.slot === 'none').sort(byOrderThenName)) {
    out.push({ section: s, heading: s.name });
  }
  return out;
}

/**
 * Split the cross-topic Sections into the one the home page leads with and the
 * rest, which render below the fold.
 *
 * The lead is the **lowest `order`**, not the one named "Updates". A tenant who
 * calls it "News", "Announcements" or "From the shop floor" must get the same layout,
 * and `order` is the field that already means "this one first" everywhere else
 * in this file. The heading the page shows is the Section's own name for the
 * same reason.
 *
 * Empty Sections never reach here — the server drops them (`crossTopicSections`)
 * — so "there is a lead" and "the lead has items" are the same statement.
 */
export function pickUpdatesSection(sections: SectionView[] | undefined): {
  lead?: SectionView;
  rest: SectionView[];
} {
  const ordered = [...(sections ?? [])].sort(byOrderThenName);
  const [lead, ...rest] = ordered;
  return lead ? { lead, rest } : { rest: [] };
}

/** Docs/wiki order: every section by `order`, then name. */
export function orderSections(sections: SectionView[]): SectionView[] {
  return [...sections].sort(byOrderThenName);
}

/**
 * The home topic: the one `site.homeTopic` names (plan §12 decision 5), else
 * the guess — slug `default`, else the first visible topic. A configured slug
 * that no longer resolves falls back rather than leaving the site without a
 * Home, since the topic may simply not be visible to this viewer.
 */
export function pickHomeTopic<T extends { slug: string }>(topics: T[], configured?: string | null): T | undefined {
  const named = configured ? topics.find((t) => t.slug === configured) : undefined;
  return named ?? topics.find((t) => t.slug === 'default') ?? topics[0];
}
