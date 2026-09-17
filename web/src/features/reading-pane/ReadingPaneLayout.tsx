/**
 * ReadingPaneLayout — on an extra-wide route, an item opens in a pane beside
 * the list it came from instead of replacing it (Eric, 2026-09-13: "similar to
 * Claude Desktop / Codex Desktop").
 *
 * Wraps a route's page (`/`, `/search`). Three states, and what each renders:
 *
 * - **Not wide** (the common case, and every phone): the page itself, with no
 *   wrapper at all — the shell's layout, the scroll container and every
 *   selector are exactly what they were before the pane existed. A plain click
 *   on an item link navigates to `/p/<slug>`.
 * - **Wide, nothing open**: the page inside a `display: contents` wrapper, so it
 *   still lays out exactly as before. The wrapper is there so that opening an
 *   item does not remount the page (a remount would lose its scroll position).
 * - **Wide, an item open**: the wrapper becomes a two-column grid — the page, as
 *   the list column (its own container queries adapt it to the narrower column),
 *   and the pane, an `aside` that is its own scroll container.
 *
 * STATE IS THE URL: `?peek=<slug>`, merged into the route's other params. Reload
 * restores the pane; a shared link or a window too narrow for it lands on
 * `/p/<slug>` instead (a REPLACE, so Back does not bounce). History policy is in
 * `peekHistoryMode`: open pushes, choosing another row replaces, reading onward
 * from inside the article pushes, close pushes.
 *
 * NOT A MODAL: no focus trap and no inert list. Opening moves focus to the
 * article's title; Escape (outside fields and dialogs) closes; closing returns
 * focus to the row that opened it.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { usePageBySlug } from '../../queries.js';
import { Icon, appIcons } from '../../icons.js';
import { ArticleReader } from '../article/ArticleReader.js';
import { ReadingPaneContext, type OpenItemOptions, type ReadingPaneState } from './ReadingPaneContext.js';
import { peekFromSearch, peekHistoryMode, shouldEscapeClosePane, withPeek } from './readingPaneModel.js';
import { READING_LAYOUT_ATTR, useWideReadingLayout } from './useWideReadingLayout.js';
import './ReadingPane.css';

/** One pane per route, so one id: the reader puts it (and tabindex=-1) on its <h1> once the item loads. */
const PANE_TITLE_ID = 'reading-pane-title';

/** How long focus waits for the article's title to render before giving up. */
const TITLE_FOCUS_TIMEOUT_MS = 10_000;

/** A modal over the page owns Escape (the quick search, the Filters dialog, a Modal). */
function modalIsOpen(): boolean {
  return !!document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]');
}

/**
 * Focus the element with this id inside `container` as soon as it exists. The
 * article fetches, so the title usually renders after the pane does.
 */
function focusWhenPresent(container: HTMLElement, id: string): () => void {
  const tryFocus = () => {
    const target = container.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!target) return false;
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
    // The pane has just been scrolled to the top; focusing must not scroll it.
    target.focus({ preventScroll: true });
    return true;
  };
  if (tryFocus()) return () => {};
  const observer = new MutationObserver(() => {
    if (tryFocus()) stop();
  });
  const timer = window.setTimeout(stop, TITLE_FOCUS_TIMEOUT_MS);
  function stop() {
    observer.disconnect();
    window.clearTimeout(timer);
  }
  observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['id'] });
  return stop;
}

/** The link in the list that opens this item, when the one that was clicked has been re-rendered away. */
function findItemLink(root: HTMLElement | null, slug: string): HTMLElement | null {
  if (!root) return null;
  for (const anchor of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    try {
      if (decodeURIComponent(new URL(anchor.href).pathname) === `/p/${slug}`) return anchor;
    } catch {
      // A malformed href is simply not the one.
    }
  }
  return null;
}

export function ReadingPaneLayout({ rootRef, children }: { rootRef: RefObject<HTMLElement>; children: ReactNode }) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const peek = useRouterState({ select: (s) => peekFromSearch(s.location.search) });
  const { wide, measured } = useWideReadingLayout(rootRef);

  const enabled = wide;
  const activeSlug = enabled ? (peek ?? null) : null;

  const layoutRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  // Refs, not state: they steer effects and focus, and must never re-render.
  const peekRef = useRef(peek);
  peekRef.current = peek;
  const originRef = useRef<HTMLElement | null>(null);
  const focusTitlePending = useRef(false);
  const closeRequested = useRef(false);
  const listScrollBeforeToggle = useRef<number | null>(null);

  // A `?peek=` with no room for a pane (a shared link, a window narrowed while
  // reading) still lands the reader on the item. Only after measuring THIS
  // mount: the initial guess must never redirect.
  useEffect(() => {
    if (measured && !wide && peek) {
      void navigate({ to: '/p/$slug', params: { slug: peek }, replace: true });
    }
  }, [measured, wide, peek, navigate]);

  const writePeek = useCallback(
    (next: string | undefined, mode: 'push' | 'replace') => {
      // Opening or closing re-lays out the list column; remember where it was.
      if (!peekRef.current !== !next) listScrollBeforeToggle.current = rootRef.current?.scrollTop ?? null;
      void navigate({
        to: pathname as never,
        search: ((previous: Record<string, unknown>) => withPeek(previous, next)) as never,
        replace: mode === 'replace',
        // The list keeps its place: this is the same page with a pane opened
        // or switched, not a new one to start at the top of.
        resetScroll: false,
      });
    },
    [navigate, pathname, rootRef],
  );

  const open = useCallback(
    (slug: string, options: OpenItemOptions = {}) => {
      const source = options.source ?? 'list';
      // Focus returns to the list row that started this, even after reading onward.
      if (source === 'list' && options.origin) originRef.current = options.origin;
      focusTitlePending.current = true;
      const mode = peekHistoryMode(peekRef.current, slug, source);
      if (mode === 'none') {
        if (paneRef.current) focusWhenPresent(paneRef.current, PANE_TITLE_ID);
        focusTitlePending.current = false;
        return;
      }
      writePeek(slug, mode);
    },
    [writePeek],
  );

  const close = useCallback(() => {
    if (!peekRef.current) return;
    closeRequested.current = true;
    writePeek(undefined, 'push');
  }, [writePeek]);

  const openFromPane = useCallback((slug: string) => open(slug, { source: 'pane' }), [open]);

  // Keep the list where it was when the grid switches on or off.
  const paneOpen = activeSlug !== null;
  useLayoutEffect(() => {
    const top = listScrollBeforeToggle.current;
    listScrollBeforeToggle.current = null;
    if (top !== null && rootRef.current) rootRef.current.scrollTop = top;
    if (paneOpen) originRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [paneOpen, rootRef]);

  // A new item starts at its top, and a reader-initiated open puts focus on its title.
  useLayoutEffect(() => {
    if (!activeSlug || !paneRef.current) return;
    paneRef.current.scrollTop = 0;
  }, [activeSlug]);
  useEffect(() => {
    if (!activeSlug || !paneRef.current || !focusTitlePending.current) return;
    focusTitlePending.current = false;
    return focusWhenPresent(paneRef.current, PANE_TITLE_ID);
  }, [activeSlug]);

  // Closing — by the button, Escape or Back — returns focus to the row, when
  // focus would otherwise be lost with the pane (or the reader asked to close).
  const previousSlug = useRef(activeSlug);
  useEffect(() => {
    const was = previousSlug.current;
    previousSlug.current = activeSlug;
    const requested = closeRequested.current;
    closeRequested.current = false;
    if (!was || activeSlug) return;
    const focused = document.activeElement;
    if (!requested && focused && focused !== document.body) return;
    const origin = originRef.current?.isConnected ? originRef.current : findItemLink(rootRef.current, was);
    origin?.focus({ preventScroll: true });
    origin?.scrollIntoView?.({ block: 'nearest' });
  }, [activeSlug, rootRef]);

  useEffect(() => {
    if (!activeSlug) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const focused = document.activeElement as HTMLElement | null;
      const closes = shouldEscapeClosePane({
        key: event.key,
        modifiers: event.metaKey || event.ctrlKey || event.altKey || event.shiftKey,
        defaultPrevented: event.defaultPrevented,
        focus: focused,
        focusWithinLayout: !!focused && !!layoutRef.current?.contains(focused),
        focusOnBody: !focused || focused === document.body,
        modalOpen: modalIsOpen(),
      });
      if (!closes) return;
      event.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [activeSlug, close]);

  const value = useMemo<ReadingPaneState>(() => ({ enabled, activeSlug, open, close }), [enabled, activeSlug, open, close]);

  return (
    <ReadingPaneContext.Provider value={value}>
      {enabled ? (
        <div ref={layoutRef} className="kp-reading-layout" {...{ [READING_LAYOUT_ATTR]: '' }} data-pane={paneOpen ? 'open' : 'closed'}>
          {children}
          {activeSlug ? <ReadingPane paneRef={paneRef} slug={activeSlug} onClose={close} onOpenItem={openFromPane} /> : null}
        </div>
      ) : (
        children
      )}
    </ReadingPaneContext.Provider>
  );
}

function ReadingPane({
  paneRef,
  slug,
  onClose,
  onOpenItem,
}: {
  paneRef: RefObject<HTMLElement>;
  slug: string;
  onClose: () => void;
  onOpenItem: (slug: string) => void;
}) {
  // Shared with the reader's own query, so the header costs no request.
  const { data: page } = usePageBySlug(slug);
  const title = page?.title ?? slug;
  return (
    <aside ref={paneRef} className="kp-reading-pane" aria-label={`Reading pane: ${title}`} data-testid="reading-pane">
      <div className="kp-reading-pane__bar">
        <span className="kp-reading-pane__title" title={title}>
          {title}
        </span>
        <Link to="/p/$slug" params={{ slug }} className="kp-reading-pane__action">
          Open full page <Icon icon={appIcons.arrowRight} fixedWidth={false} />
        </Link>
        <button type="button" className="kp-reading-pane__close" aria-label="Close reading pane" onClick={onClose}>
          <Icon icon={appIcons.xmark} fixedWidth={false} />
        </button>
      </div>
      <div className="kp-reading-pane__body">
        {/* One reader for the pane's lifetime, NOT keyed by slug: it counts a
            page view once per slug per mount itself, so switching items is a
            prop change and a remount would only add work. The pane adds no
            telemetry of its own. */}
        <ArticleReader slug={slug} variant="pane" onOpenItem={onOpenItem} titleId={PANE_TITLE_ID} />
      </div>
    </aside>
  );
}
