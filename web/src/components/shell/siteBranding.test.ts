/**
 * `<SiteBrand>`'s fallbacks (reader plan §4, R2.2).
 *
 * The requirement these guard: an instance that configures nothing must render
 * exactly as it did before branding existed, and a half-filled `site:` block
 * must never leave a hole where the logo or the name was.
 */
import { describe, it, expect } from 'vitest';
import { resolveSiteBrand, usablePinnedTopics, usableSiteLinks, SITE_DEFAULTS, type PinnedTopic, type SiteConfigPayload } from './siteBranding.js';

/** `GET /site` on an instance with no `site:` block at all. */
const UNSET: SiteConfigPayload = {
  home_topic: null,
  name: null,
  short_name: null,
  logo: null,
  logo_dark: null,
  favicon: null,
  tagline: null,
  search_placeholder: null,
};

describe('resolveSiteBrand', () => {
  it('falls back to the product mark and wordmark when nothing is configured', () => {
    expect(resolveSiteBrand(UNSET)).toEqual({
      name: SITE_DEFAULTS.name,
      shortName: SITE_DEFAULTS.name,
      logo: SITE_DEFAULTS.logo,
      logoDark: SITE_DEFAULTS.logoDark,
      favicon: SITE_DEFAULTS.favicon,
      tagline: SITE_DEFAULTS.tagline,
      usingDefaultName: true,
    });
  });

  it('gives the same answer before the fetch lands, so the chrome never renders blank', () => {
    expect(resolveSiteBrand(undefined)).toEqual(resolveSiteBrand(UNSET));
    expect(resolveSiteBrand(null)).toEqual(resolveSiteBrand(UNSET));
  });

  it('leaves the search placeholder unset, so each surface keeps its own wording', () => {
    expect(resolveSiteBrand(UNSET).searchPlaceholder).toBeUndefined();
    expect(resolveSiteBrand({ ...UNSET, search_placeholder: 'Search runbooks…' }).searchPlaceholder).toBe(
      'Search runbooks…',
    );
  });

  it('uses a configured logo for both themes when only the light one is given', () => {
    const brand = resolveSiteBrand({ ...UNSET, logo: '/assets/acme.svg' });
    expect(brand.logo).toBe('/assets/acme.svg');
    // Not the product's dark cube: one logo in both themes is a normal choice.
    expect(brand.logoDark).toBe('/assets/acme.svg');
    // And the favicon follows the logo rather than the product's.
    expect(brand.favicon).toBe('/assets/acme.svg');
  });

  it('prefers an explicit dark logo and favicon over the light one', () => {
    const brand = resolveSiteBrand({
      ...UNSET,
      logo: '/assets/acme-light.svg',
      logo_dark: '/assets/acme-dark.svg',
      favicon: '/assets/acme-icon.png',
    });
    expect(brand.logoDark).toBe('/assets/acme-dark.svg');
    expect(brand.favicon).toBe('/assets/acme-icon.png');
  });

  it('keeps the product mark when only a name is configured', () => {
    const brand = resolveSiteBrand({ ...UNSET, name: 'Acme Engineering Knowledge' });
    expect(brand.name).toBe('Acme Engineering Knowledge');
    expect(brand.shortName).toBe('Acme Engineering Knowledge');
    expect(brand.logo).toBe(SITE_DEFAULTS.logo);
    // The `× 10³` superscript belongs to the product's own wordmark only.
    expect(brand.usingDefaultName).toBe(false);
  });

  it('uses the short name for the collapsed rail when one is given', () => {
    expect(resolveSiteBrand({ ...UNSET, name: 'Acme Engineering Knowledge', short_name: 'Acme' })).toMatchObject({
      name: 'Acme Engineering Knowledge',
      shortName: 'Acme',
    });
  });

  it('treats blank and whitespace-only values as unset, and trims the rest', () => {
    const brand = resolveSiteBrand({ ...UNSET, name: '   ', tagline: '  Ask anything.  ' });
    expect(brand.name).toBe(SITE_DEFAULTS.name);
    expect(brand.usingDefaultName).toBe(true);
    expect(brand.tagline).toBe('Ask anything.');
  });
});

describe('usableSiteLinks', () => {
  it('keeps in-app routes and external http(s)/mailto links, in order', () => {
    const links = [
      { label: 'Onboarding checklist', to: '/p/onboarding' },
      { label: 'Sections', to: '/sections', description: 'Everything we curate' },
      { label: 'Request a tool', href: 'https://intranet.example/tools' },
      { label: 'Ask the team', href: 'mailto:knowledge@example.com' },
    ];
    expect(usableSiteLinks(links)).toEqual(links);
  });

  it('drops anything that could not have come from a valid index.md', () => {
    expect(
      usableSiteLinks([
        { label: '', to: '/sections' },
        { label: 'No destination' },
        { label: 'Both', to: '/sections', href: 'https://example.test' },
        { label: 'Protocol relative', to: '//evil.example/x' },
        { label: 'Script', href: 'javascript:alert(1)' },
        { label: 'Relative', to: 'sections' },
      ]),
    ).toEqual([]);
  });

  it('is empty, never undefined, when there are no links at all', () => {
    expect(usableSiteLinks(undefined)).toEqual([]);
    expect(usableSiteLinks([])).toEqual([]);
  });
});

describe('usablePinnedTopics', () => {
  const pin = (over: Partial<PinnedTopic> = {}): PinnedTopic => ({
    topic: 'ai',
    name: 'AI',
    description: null,
    color: null,
    cover: null,
    cover_dark: null,
    ...over,
  });

  it('keeps the resolved pins, in the curator order', () => {
    const pins = [pin({ topic: 'widget-pro', name: 'Widget Pro' }), pin()];
    expect(usablePinnedTopics(pins)).toEqual(pins);
  });

  it('drops a pin the server could not resolve to a topic', () => {
    // The server already withholds these from every viewer but an admin — and
    // the admin is also a READER of the front page, where a dead pin must not
    // render as an unnamed card just because they can see it in the editor.
    expect(usablePinnedTopics([pin({ topic: 'ghost', name: null }), pin()])).toEqual([pin()]);
    expect(usablePinnedTopics([pin({ name: '  ' })])).toEqual([]);
    expect(usablePinnedTopics([pin({ topic: '' })])).toEqual([]);
  });

  it('is empty, never undefined, on an uncurated instance', () => {
    expect(usablePinnedTopics(undefined)).toEqual([]);
    expect(usablePinnedTopics([])).toEqual([]);
  });
});
