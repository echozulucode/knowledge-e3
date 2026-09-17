/**
 * `<SiteBrand>` — the site's logo and wordmark, from `GET /site` (reader plan
 * §4, R2.2).
 *
 * Every chrome surface renders this rather than its own `<img>`, so a company
 * sets its logo in one place and it is the same logo everywhere. The document
 * title and the favicon are driven from the same payload by `useSiteChrome`,
 * with `index.html`'s literals serving as the pre-hydration fallback.
 */
import React, { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../../api.js';
import { resolveSiteBrand, usableSiteLinks, type PinnedTopic, type SiteBrand as SiteBrandView, type SiteConfigPayload, type SiteLink } from './siteBranding.js';

/**
 * `GET /site`, cached forever.
 *
 * Shares the `['site-config']` key with `useSiteConfig` in
 * `features/topic/queries.ts` on purpose: it is the same request, so the two
 * hooks resolve from one fetch and can never disagree about which topic is Home.
 */
export function useSiteConfigPayload() {
  return useQuery({
    queryKey: ['site-config'],
    queryFn: () => apiClient.get<SiteConfigPayload>('/site'),
    staleTime: Infinity,
  });
}

/** The site's identity with every fallback applied. Safe to call before the fetch lands. */
export function useSiteBrand(): SiteBrandView {
  const { data } = useSiteConfigPayload();
  return resolveSiteBrand(data);
}

/**
 * Curated landing-page links for a topic (reader plan §4, R2.4), read by the
 * server from that topic's bundle `index.md`. Disabled until the caller knows
 * which topic it is showing; an unresolvable or uncurated topic answers `[]`,
 * so a caller never has to handle an error to render a front page.
 */
export function useSiteLinks(topic: string | undefined) {
  return useQuery({
    queryKey: ['site-links', topic ?? ''],
    queryFn: async () => {
      const path = topic ? `/site/links?topic=${encodeURIComponent(topic)}` : '/site/links';
      const res = await apiClient.get<{ links: SiteLink[] }>(path);
      return usableSiteLinks(res.links);
    },
    staleTime: 60_000,
  });
}

/**
 * The home page's featured topics (home-prototype plan §3.3), resolved by the
 * server for the calling viewer — so a topic this visitor may not see is
 * already gone, and `cover_dark` has already fallen back to `cover`.
 *
 * Same `/site/*` family as the links above, and the same contract: an
 * uncurated instance answers `[]` rather than an error, because the front page
 * must render whatever the administrator has or has not done.
 */
export function usePinnedTopics() {
  return useQuery({
    queryKey: ['site-pinned'],
    queryFn: async () => (await apiClient.get<{ pinned: PinnedTopic[] }>('/site/pinned')).pinned,
    staleTime: 60_000,
  });
}

/**
 * Put the tenant's name in the browser tab and its favicon in the tab strip.
 *
 * Mounted once, by `<SiteBrand>` in the sidebar, which is on every screen. The
 * `<title>` and `<link rel="icon">` already in `index.html` are what a visitor
 * sees before this runs, so an unconfigured instance never flickers.
 */
export function useSiteChrome(brand: SiteBrandView): void {
  useEffect(() => {
    document.title = brand.name;
  }, [brand.name]);

  useEffect(() => {
    // Replace every icon link (index.html declares one per colour scheme) so a
    // configured favicon wins in both, rather than racing the media queries.
    const links = document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]');
    if (links.length === 0) {
      const link = document.createElement('link');
      link.rel = 'icon';
      link.href = brand.favicon;
      document.head.appendChild(link);
      return;
    }
    for (const link of links) {
      link.removeAttribute('media');
      link.href = brand.favicon;
    }
  }, [brand.favicon]);
}

interface SiteBrandProps {
  /**
   * `mark` renders the logo alone (the collapsed rail, a logo button), `name`
   * the wordmark alone, `full` both. Splitting them keeps each surface's own
   * layout intact — the sidebar puts the mark inside a button and the wordmark
   * beside it — without any surface reaching for the logo URL itself.
   */
  variant?: 'mark' | 'name' | 'full';
  /** Class for the logo image, so each surface keeps its own sizing. */
  logoClassName?: string;
  /** Class for the wordmark. */
  nameClassName?: string;
}

/**
 * The mark plus the wordmark. Both logo variants are always in the DOM and the
 * theme chooses between them in CSS (`.kp-logo-light` / `.kp-logo-dark` in
 * GlobalHeader.css) — the same mechanism as before, so the swap still happens
 * without JavaScript and without a flash on load. A tenant with one logo simply
 * has the same URL in both.
 */
export const SiteBrand: React.FC<SiteBrandProps> = ({ variant = 'full', logoClassName, nameClassName }) => {
  const brand = useSiteBrand();
  useSiteChrome(brand);

  return (
    <>
      {variant !== 'name' && (
        <>
          <img
            src={brand.logo}
            alt=""
            aria-hidden="true"
            data-site-logo="light"
            className={`${logoClassName ?? ''} kp-logo-light`.trim()}
          />
          <img
            src={brand.logoDark}
            alt=""
            aria-hidden="true"
            data-site-logo="dark"
            className={`${logoClassName ?? ''} kp-logo-dark`.trim()}
          />
        </>
      )}
      {variant !== 'mark' && (
        <span className={nameClassName} data-site-name="">
          {brand.usingDefaultName ? (
            <>
              Knowledge × 10<sup>3</sup>
            </>
          ) : (
            brand.name
          )}
        </span>
      )}
    </>
  );
};
