/**
 * itemLink — the one place `@echozedlabs/ui`'s item components meet the router.
 *
 * The package deliberately does not depend on `@tanstack/react-router` (see the
 * note in ItemCard.tsx), so every surface that renders an `ItemCard`/`ItemRow`
 * would otherwise write the same four-line `renderLink` arrow. It is written
 * once here instead, which also means every index links to `/p/:slug` the same
 * way — a client-side navigation, never a full page load.
 *
 * It is also the one place an item link meets the READING PANE
 * (features/reading-pane). On a route wide enough to host one, a plain click
 * opens the item beside the list instead of navigating; the link is still a real
 * `<a href="/p/slug">`, so a middle click, a modified click, "open in new tab"
 * and "copy link" are untouched. Anywhere without a pane — no provider, or not
 * wide enough — the rendered link is exactly what it was before the pane.
 */
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { RenderItemLink } from '@echozedlabs/ui';
import { useReadingPane } from '../features/reading-pane/ReadingPaneContext.js';
import { isPlainPrimaryClick } from '../features/reading-pane/readingPaneModel.js';

/**
 * A router link to `/p/:slug` that opens the reading pane instead, when the
 * route has one. A component rather than inline JSX in `itemSlugLink`, because
 * it reads context: `renderLink` is called as a plain function (PopularList
 * calls it directly), where a hook could not run.
 */
export function ItemSlugLink({ slug, className, children }: { slug: string; className?: string; children: ReactNode }) {
  const pane = useReadingPane();
  if (!pane?.enabled) {
    return (
      <Link to="/p/$slug" params={{ slug }} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <Link
      to="/p/$slug"
      params={{ slug }}
      className={className}
      aria-current={pane.activeSlug === slug ? 'true' : undefined}
      onClick={(event) => {
        const anchor = event.currentTarget;
        if (!isPlainPrimaryClick(event, { target: anchor.getAttribute('target'), download: anchor.hasAttribute('download') })) return;
        // Default-prevented, the router's own handler stands down: no navigation.
        event.preventDefault();
        pane.open(slug, { origin: anchor });
      }}
    >
      {children}
    </Link>
  );
}

/** Renders an item title as a router link to `/p/:slug` (or into the reading pane, where there is one). */
export const itemSlugLink =
  (slug: string): RenderItemLink =>
  ({ className, children }) => (
    <ItemSlugLink slug={slug} className={className}>
      {children}
    </ItemSlugLink>
  );

/** The `href` the components use for the anchor; kept in step with the link above. */
export function itemHref(slug: string): string {
  return `/p/${slug}`;
}
