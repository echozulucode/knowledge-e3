/**
 * Tenant branding, resolved (reader plan §4, R2.1/R2.2).
 *
 * The rule this file exists to enforce: **one source for the site's identity**.
 * Before this, the logo lived in `Sidebar.tsx`, the wordmark beside it, the
 * document title in `index.html` and the hero line in `Home.tsx`, so a company
 * could only rebrand the product by forking it. Now `GET /site` supplies all
 * four and every surface reads them through here.
 *
 * Pure on purpose — no React — so the fallbacks can be asserted directly.
 */

/** `GET /api/v1/site`. Every field is nullable: null means "the operator set nothing". */
export interface SiteConfigPayload {
  home_topic: string | null;
  name?: string | null;
  short_name?: string | null;
  logo?: string | null;
  logo_dark?: string | null;
  favicon?: string | null;
  tagline?: string | null;
  search_placeholder?: string | null;
}

/**
 * What the product is called and looks like when nobody has configured
 * anything: exactly today's hard-coded values, so an unconfigured instance is
 * pixel-for-pixel what it was.
 */
export const SITE_DEFAULTS = {
  name: 'Knowledge × 10³',
  logo: '/logo/ke3-cube-light.png',
  logoDark: '/logo/ke3-cube-dark.png',
  favicon: '/logo/ke3-cube-light.png',
  tagline: 'What do you want to do with AI?',
} as const;

/** Branding with every fallback already applied; nothing downstream is optional. */
export interface SiteBrand {
  name: string;
  shortName: string;
  logo: string;
  logoDark: string;
  favicon: string;
  tagline: string;
  /**
   * Configured only — undefined when the operator set none. Deliberately NOT
   * defaulted here: the rail, the portal hero and the library hero each have
   * their own wording today, and each keeps it as its own fallback, so an
   * unconfigured instance reads exactly as it did.
   */
  searchPlaceholder?: string;
  /**
   * True when the operator named no site, so the chrome is showing the product's
   * own wordmark. Only then is the name rendered with its `× 10³` superscript —
   * a tenant's name is text, not a piece of typography we invent for them.
   */
  usingDefaultName: boolean;
}

/** A configured string, or undefined when it is null, absent or blank. */
function text(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Resolve the payload (or its absence, while `GET /site` is still in flight)
 * into a complete brand. Never throws and never returns a blank: a half-filled
 * `site:` block falls back field by field, so configuring only a name keeps the
 * product's mark rather than leaving a hole where the logo was.
 */
export function resolveSiteBrand(site: SiteConfigPayload | undefined | null): SiteBrand {
  const configuredName = text(site?.name);
  const name = configuredName ?? SITE_DEFAULTS.name;
  const logo = text(site?.logo);
  return {
    name,
    // A tenant that gives only a long name gets it in the collapsed rail too;
    // that is better than inventing an abbreviation for them.
    shortName: text(site?.short_name) ?? name,
    logo: logo ?? SITE_DEFAULTS.logo,
    // The dark variant falls back to the light logo, not to the product's mark:
    // one logo in both themes is a normal choice, two different brands is not.
    logoDark: text(site?.logo_dark) ?? logo ?? SITE_DEFAULTS.logoDark,
    favicon: text(site?.favicon) ?? logo ?? SITE_DEFAULTS.favicon,
    tagline: text(site?.tagline) ?? SITE_DEFAULTS.tagline,
    ...(text(site?.search_placeholder) ? { searchPlaceholder: text(site?.search_placeholder)! } : {}),
    usingDefaultName: configuredName === undefined,
  };
}

/** One curated landing-page link from the topic bundle's `index.md` (`links:`). */
export interface SiteLink {
  label: string;
  /** In-app route. Exactly one of `to` / `href` is set. */
  to?: string;
  href?: string;
  description?: string;
}

/**
 * One featured topic on the home page, as `GET /site/pinned` resolves it.
 * `name` is null only for an administrator, who is shown a pin that no longer
 * names a topic so the admin surface can offer to fix it; every other viewer
 * never receives those rows at all.
 */
export interface PinnedTopic {
  /** Topic slug — route-usable, resolved server-side. */
  topic: string;
  name: string | null;
  description: string | null;
  /** A palette token name (`teal`, `ochre`, …), or null. Never a raw colour. */
  color: string | null;
  /** A topic icon token (`PIN_ICONS`), or null. */
  icon?: string | null;
  cover: string | null;
  cover_dark: string | null;
}

/**
 * The pins a reading surface may render: those that resolved to a topic.
 *
 * The server has already dropped the rest for everyone but an admin, so this is
 * the client half of one rule rather than a second rule — the same relationship
 * `usableSiteLinks` has with the server's link validation. It matters because
 * the *admin* is also a reader of the front page, and a dead pin must not
 * render there as an unnamed card just because they can see it in the editor.
 */
export function usablePinnedTopics(pinned: PinnedTopic[] | undefined): PinnedTopic[] {
  return (pinned ?? []).filter((pin) => !!pin?.topic?.trim() && !!pin.name?.trim());
}

/**
 * Drop anything the server would not have sent, so a stale cache or a hand-rolled
 * response cannot put a `javascript:` URL into an anchor. The server validates
 * the same way when it parses `index.md`; this is the client half of the same
 * rule, applied where the anchor is actually built.
 */
export function usableSiteLinks(links: SiteLink[] | undefined): SiteLink[] {
  return (links ?? []).filter((link) => {
    if (!link?.label?.trim()) return false;
    if (link.to) return !link.href && link.to.startsWith('/') && !link.to.startsWith('//');
    return !!link.href && /^(?:https?:|mailto:)/i.test(link.href);
  });
}
