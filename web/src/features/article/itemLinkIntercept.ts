/**
 * Which clicks inside an embedded article open the target in the same pane.
 *
 * The reading pane (extra-wide screens) keeps the result list beside the
 * article, so following a wiki link, a series Previous/Next or a Related entry
 * must swap the article in the pane rather than leave the list behind. Every
 * one of those is already an ordinary anchor to `/p/<slug>` — a plain `<a>` from
 * ReadView, a router `<Link>` from SeriesNav and RelatedPanel — so the decision
 * is made ONCE, here, from the anchor and the click, rather than by teaching
 * each renderer about panes.
 *
 * Only the reader's "just open it" gesture is taken over. A modifier or middle
 * click means "somewhere else" (new tab, new window, download) and keeps the
 * browser's behaviour, and anything that is not an item — tags, search, topic,
 * external sites, the item's edit route — navigates as it always has.
 */

/** The parts of a mouse event the decision reads (a React or DOM event fits). */
export interface ClickLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

/** The parts of the clicked anchor the decision reads. */
export interface AnchorLike {
  /** The raw `href` attribute (not the resolved property). */
  href: string | null;
  target?: string | null;
  download?: boolean;
}

/** `/p/<slug>` exactly — `/p/<slug>/edit` is Compose, not a read. */
const ITEM_PATH = /^\/p\/([^/]+)\/?$/;

/**
 * The item slug to open in place, or `null` to let the click do what it does.
 * `origin` is the app's own origin (`window.location.origin`); an absolute link
 * to it counts, one to anywhere else never does.
 */
export function interceptedItemSlug(click: ClickLike, anchor: AnchorLike, origin: string): string | null {
  if (click.defaultPrevented) return null;
  if (click.button !== 0) return null;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null;
  if (anchor.download) return null;
  if (anchor.target && anchor.target !== '_self') return null;
  if (!anchor.href) return null;

  let url: URL;
  try {
    url = new URL(anchor.href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const match = ITEM_PATH.exec(url.pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!) || null;
  } catch {
    return null;
  }
}
