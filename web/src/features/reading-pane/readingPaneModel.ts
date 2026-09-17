/**
 * The reading pane's decisions, kept pure so they are testable without a
 * browser (reader idea, Eric 2026-09-13: "Only for extra wide screens, when you
 * click on a search result or a home page item, it opens the content in a right
 * pane, similar to Claude Desktop / Codex Desktop").
 *
 * Everything the pane does is one of four questions, and each is answered here:
 *
 * - **Is there room?** `isWideReadingInline` — measured against the ROUTE's
 *   inline size, never the viewport, because the expanded app sidebar takes
 *   264px of the same screen.
 * - **Which item is open?** `peekFromSearch` — the URL is the state (`?peek=`),
 *   so a reload, a shared link and Back all agree with what is on screen.
 * - **Does this click open it?** `isPlainPrimaryClick` — only the reader's
 *   "just open it" gesture; a modifier or middle click keeps the browser's.
 * - **What does it cost the history?** `peekHistoryMode` — see the policy there.
 */

/**
 * The route's inline size, in rem, at which the pane exists at all.
 *
 * WHY 110rem: the split is half and half (ReadingPane.css), so each side gets
 * at least 55rem at the threshold — enough for the Updates column / a result
 * list with gutters on the left, and a ~72ch article plus the pane's padding
 * and scrollbar on the right. The app's root font size is 15px, so 110rem is
 * 1650px of route width: a 1920px window with the rail collapsed (68px) or
 * expanded (264px) both qualify; a 1440px laptop never does.
 */
export const READING_PANE_MIN_INLINE_REM = 110;

/** The browser default, for a root font size that cannot be read. */
const FALLBACK_ROOT_FONT_PX = 16;

/** Whether a route this wide (CSS px) gets the pane, at this root font size. */
export function isWideReadingInline(inlinePx: number, rootFontPx: number = FALLBACK_ROOT_FONT_PX): boolean {
  const remPx = Number.isFinite(rootFontPx) && rootFontPx > 0 ? rootFontPx : FALLBACK_ROOT_FONT_PX;
  return Number.isFinite(inlinePx) && inlinePx >= READING_PANE_MIN_INLINE_REM * remPx;
}

/**
 * The open item's slug from router search params, or `undefined`.
 *
 * The router's default parser JSON-decodes values, so `?peek=2024` arrives as a
 * number; a slug is a string either way. Anything else (an object, an empty
 * string) is no item.
 */
export function peekFromSearch(search: unknown): string | undefined {
  if (!search || typeof search !== 'object') return undefined;
  const raw = (search as { peek?: unknown }).peek;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw !== 'string') return undefined;
  const slug = raw.trim();
  return slug || undefined;
}

/**
 * `validateSearch` for a route that hosts the pane. The router MERGES a route's
 * validated search over the raw params, so returning only `peek` leaves every
 * other key (`q`, `tag`, …) exactly as it was.
 */
export function validatePeekSearch(search: Record<string, unknown>): { peek?: string } {
  const peek = peekFromSearch(search);
  return peek ? { peek } : {};
}

/** `search` with `peek` set to this slug, or removed — never duplicated, nothing else touched. */
export function withPeek(search: Record<string, unknown> | undefined, peek: string | undefined): Record<string, unknown> {
  const { peek: _previous, ...rest } = search ?? {};
  return peek ? { ...rest, peek } : rest;
}

/** Where an open request came from: a row in the list, or a link inside the article. */
export type PeekSource = 'list' | 'pane';

/**
 * How a pane change is written to history.
 *
 * - **Opening** from closed PUSHES: Back closes the pane, which is what "I did
 *   not mean to open that" wants.
 * - **Choosing another row** REPLACES: scanning ten results is one visit to the
 *   list, not ten entries to walk back through.
 * - **Following a link inside the article** (wiki link, series, Related) PUSHES:
 *   that is reading onward, and Back should return to the article it came from,
 *   exactly as it would on the full page.
 * - **Closing** PUSHES: Back reopens what was just closed.
 * - The same item again is no navigation at all.
 */
export function peekHistoryMode(current: string | undefined, next: string | undefined, source: PeekSource = 'list'): 'none' | 'push' | 'replace' {
  if ((current || undefined) === (next || undefined)) return 'none';
  if (!current || !next) return 'push';
  return source === 'pane' ? 'push' : 'replace';
}

/** The parts of a click the decision reads (a React or DOM mouse event fits). */
export interface ClickLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

/**
 * Whether a click on an item link is the reader's plain "open it": the primary
 * button, no modifier, not already handled, and a link that targets this tab.
 * Everything else — a new tab, a new window, a download — stays the browser's.
 */
export function isPlainPrimaryClick(click: ClickLike, anchor?: { target?: string | null; download?: boolean } | null): boolean {
  if (click.defaultPrevented || click.button !== 0) return false;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false;
  if (anchor?.download) return false;
  if (anchor?.target && anchor.target !== '_self') return false;
  return true;
}

/** The parts of the focused element the Escape decision reads. */
export interface FocusLike {
  tagName: string;
  isContentEditable?: boolean;
}

/** A field that uses Escape itself (clearing, closing a native picker): the pane leaves it alone. */
export function isEditableTarget(element: FocusLike | null | undefined): boolean {
  if (!element) return false;
  const tag = element.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!element.isContentEditable;
}

/**
 * Whether Escape closes the pane. Only when focus is somewhere the pane is the
 * obvious referent — inside the list or the pane, or nowhere in particular —
 * and never while a field owns the key or a modal dialog is open over the page.
 */
export function shouldEscapeClosePane(input: {
  key: string;
  modifiers: boolean;
  defaultPrevented: boolean;
  focus: FocusLike | null;
  focusWithinLayout: boolean;
  focusOnBody: boolean;
  modalOpen: boolean;
}): boolean {
  if (input.key !== 'Escape' || input.modifiers || input.defaultPrevented || input.modalOpen) return false;
  if (isEditableTarget(input.focus)) return false;
  return input.focusWithinLayout || input.focusOnBody;
}
