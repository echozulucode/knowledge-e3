/**
 * useWideReadingLayout — whether the route has room for the reading pane.
 *
 * It measures the ROUTE's available inline size, not the viewport: the app
 * sidebar (68px collapsed, 264px expanded) and the mobile drawer change the room
 * a page has independently of the window, which is also why the pages themselves
 * lay out with container queries rather than media queries.
 *
 * What is measured is the route root's nearest box that the pane does not
 * create — the shell's content region (`.kp-main`). Not the route root itself:
 * once the pane opens, the root narrows to the list column, and measuring it
 * would close the pane it just made room for.
 *
 * The CSS never decides the layout on its own: `ReadingPaneLayout` switches the
 * grid on with an attribute from THIS value, so the click-time decision and the
 * layout on screen cannot disagree.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { isWideReadingInline } from './readingPaneModel.js';

/** Marks the pane's own wrapper, which is `display: contents` or a grid — never the box to measure. */
export const READING_LAYOUT_ATTR = 'data-reading-layout';

/**
 * The last answer any route got. A route that mounts after another (Home → Search)
 * starts from it, so the page is rendered in its final shape the first time
 * instead of being remounted once the measurement lands.
 */
let lastKnownWide = false;

function measuredHost(root: HTMLElement): HTMLElement | null {
  let host = root.parentElement;
  while (host && host.hasAttribute(READING_LAYOUT_ATTR)) host = host.parentElement;
  return host;
}

function rootFontPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize);
}

export interface WideReadingLayout {
  /** Room for the pane (the last known answer until `measured`). */
  wide: boolean;
  /** Whether `wide` comes from measuring THIS mount — gate anything irreversible (a redirect) on it. */
  measured: boolean;
}

export function useWideReadingLayout(ref: RefObject<HTMLElement>): WideReadingLayout {
  const [state, setState] = useState<WideReadingLayout>(() => ({ wide: lastKnownWide, measured: false }));
  const hostRef = useRef<HTMLElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const wideRef = useRef(state.wide);
  // Crossing the threshold changes whether the page sits inside the pane's
  // wrapper, which remounts it (a wrapper below the threshold would change the
  // shell's layout). The list's scroll position is carried across by hand.
  const carriedScroll = useRef<number | null>(null);

  // No dependency list on purpose: the route root can be replaced (that remount),
  // and the observer must follow whichever host the current root sits in. It
  // re-subscribes only when that host actually changes.
  useLayoutEffect(() => {
    const root = ref.current;
    const host = root ? measuredHost(root) : null;
    if (host === hostRef.current) return;
    observerRef.current?.disconnect();
    observerRef.current = null;
    hostRef.current = host;
    if (!host) return;

    const apply = (inlinePx: number) => {
      const wide = isWideReadingInline(inlinePx, rootFontPx());
      if (wide !== wideRef.current) carriedScroll.current = ref.current?.scrollTop ?? null;
      wideRef.current = wide;
      lastKnownWide = wide;
      setState((previous) => (previous.wide === wide && previous.measured ? previous : { wide, measured: true }));
    };

    // Synchronously first, so the first paint already has the right shape.
    apply(host.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) apply(host.clientWidth);
    });
    observer.observe(host);
    observerRef.current = observer;
  });

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      hostRef.current = null;
    },
    [],
  );

  useLayoutEffect(() => {
    const top = carriedScroll.current;
    carriedScroll.current = null;
    if (top !== null && ref.current) ref.current.scrollTop = top;
  }, [state.wide, ref]);

  return state;
}
