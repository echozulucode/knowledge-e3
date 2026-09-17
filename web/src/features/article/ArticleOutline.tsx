/**
 * "On this page" for an article read in the reading pane.
 *
 * On the item page the context pane's TOC tab does this job; the pane has no
 * context pane, so the same outline (`headingOutline`, the TOC's own
 * extraction) sits above the body as a closed disclosure — present when wanted,
 * one line when not.
 *
 * Picking a section scrolls the NEAREST scroll container rather than calling
 * `scrollIntoView`, which scrolls every scrollable ancestor it can find: in a
 * pane beside a result list that would also shift the list, and the reader
 * would lose their place in it.
 */
import { useId, useRef } from 'react';
import type { TocEntry } from '../../components/RightContextPane.js';

interface ArticleOutlineProps {
  entries: TocEntry[];
  /** Where the headings live; ids are looked up inside it, not document-wide. */
  root: HTMLElement | null;
}

function isScrollable(el: HTMLElement): boolean {
  const { overflowY } = getComputedStyle(el);
  return (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') && el.scrollHeight > el.clientHeight;
}

/** The closest ancestor that actually scrolls, else the document's scroller. */
function nearestScrollContainer(el: HTMLElement): HTMLElement {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (isScrollable(node)) return node;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

function scrollToHeading(root: HTMLElement | null, id: string): void {
  if (!root) return;
  const heading = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (!heading) return;
  const container = nearestScrollContainer(heading);
  // `scroll-margin-top` (set in ArticleReader.css) keeps the heading clear of
  // the pane's sticky header, the same way it would for a native anchor jump.
  const margin = parseFloat(getComputedStyle(heading).scrollMarginTop) || 0;
  const top = container === document.scrollingElement
    ? heading.getBoundingClientRect().top + window.scrollY - margin
    : heading.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - margin;
  container.scrollTo({ top, behavior: 'smooth' });
  // Keyboard and screen-reader users land where the eye does.
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
}

export function ArticleOutline({ entries, root }: ArticleOutlineProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const labelId = useId();
  if (entries.length === 0) return null;

  return (
    <details ref={detailsRef} className="kp-article-outline" data-testid="article-outline">
      <summary className="kp-article-outline__summary" id={labelId}>
        On this page <span className="kp-article-outline__count">{entries.length}</span>
      </summary>
      <nav className="kp-article-outline__list" aria-labelledby={labelId}>
        {entries.map((entry, index) => (
          <button
            key={`${entry.id}-${index}`}
            type="button"
            className="kp-article-outline__link"
            data-depth={Math.min(entry.depth, 3)}
            onClick={() => {
              if (detailsRef.current) detailsRef.current.open = false;
              scrollToHeading(root, entry.id);
            }}
          >
            {entry.text}
          </button>
        ))}
      </nav>
    </details>
  );
}
