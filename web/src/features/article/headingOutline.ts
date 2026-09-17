/**
 * The article's heading outline — what the page's right-pane TOC lists and what
 * the reading pane's "On this page" menu lists.
 *
 * One extraction for both surfaces (it used to be an inline IIFE in PageView),
 * so the two can never disagree about which sections an article has. Parsed from
 * the SOURCE markdown rather than the rendered DOM because the page's TOC must
 * exist on the first render, before ReadView's lazily-rendered blocks settle.
 * The ids come from ReadView's own `headingSlug`, which is what it stamps on the
 * rendered headings — change one and the other follows.
 */
import { headingSlug } from '../../components/ReadView.js';
import type { TocEntry } from '../../components/RightContextPane.js';

/** H1–H3 in source order; headings inside fenced code are not headings. */
export function headingOutline(markdown: string | null | undefined): TocEntry[] {
  const out: TocEntry[] = [];
  let inFence = false;
  for (const raw of (markdown ?? '').split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,3})\s+(.+?)\s*#*$/.exec(line);
    if (!m) continue;
    const text = m[2]!.replace(/[`*_~]/g, '').trim();
    if (text) out.push({ depth: m[1]!.length, text, id: headingSlug(text) });
  }
  return out;
}
