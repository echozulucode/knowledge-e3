/**
 * The admin console's navigation, as data (the admin UX review §3.1): three
 * named groups under Overview, every destination keeping the label it had as a
 * tab. Kept free of React so the one rule that has bitten before — which item
 * is lit for a path — is unit-tested rather than eyeballed.
 *
 * Active resolution is LONGEST PREFIX ON A SEGMENT BOUNDARY across every
 * destination. The admin paths nest (`/admin/health` is a prefix of
 * `/admin/health/system`, `/admin/sections` of `/admin/sections/pinned`), so a
 * plain `startsWith` lit two entries at once; the AdminTabs it replaces patched
 * that per entry with `exact` flags. Longest-prefix gets it right for paths no
 * one listed too: `/admin/sections/new` and `/admin/sections/<slug>` resolve to
 * Sections because nothing longer matches them.
 */
import type { SourceStatusView } from '../../features/sources/types.js';
import type { SystemVerdict } from '../../features/health/systemVerdict.js';

export type AdminBadgeKind = 'sources' | 'health';

export interface AdminNavLink {
  id: string;
  /** The label as the nav shows it. Never renamed from the old tab label. */
  label: string;
  to: string;
  /** Only this exact path, never a child path (Overview is `/admin`, the prefix of everything). */
  exact?: boolean;
  /**
   * What the phone switcher says for this page when the short label would be
   * ambiguous on its own ("System" out of context says nothing).
   */
  pageLabel?: string;
}

export interface AdminNavItem extends AdminNavLink {
  /** Sub-destinations, revealed while the item is active. The item links to its default child. */
  children?: readonly AdminNavLink[];
  badge?: AdminBadgeKind;
}

export interface AdminNavGroup {
  id: string;
  /** Absent for the ungrouped Overview entry at the top. */
  heading?: string;
  items: readonly AdminNavItem[];
}

export const ADMIN_NAV: readonly AdminNavGroup[] = [
  { id: 'overview', items: [{ id: 'overview', label: 'Overview', to: '/admin', exact: true }] },
  {
    id: 'people',
    heading: 'People & access',
    items: [
      { id: 'users', label: 'Users', to: '/admin/users' },
      {
        id: 'auth',
        label: 'Authentication',
        to: '/admin/auth',
        children: [
          { id: 'auth-settings', label: 'Authentication', to: '/admin/auth' },
          { id: 'tokens', label: 'API tokens', to: '/admin/auth/tokens' },
        ],
      },
      { id: 'audit', label: 'Audit', to: '/admin/audit' },
    ],
  },
  {
    id: 'content',
    heading: 'Content',
    items: [
      {
        id: 'taxonomy',
        label: 'Taxonomy',
        to: '/admin/topics',
        children: [
          { id: 'topics', label: 'Topics', to: '/admin/topics' },
          { id: 'categories', label: 'Categories', to: '/admin/primary-categories', pageLabel: 'Primary categories' },
          { id: 'tags-groups', label: 'Tags & groups', to: '/admin/tags-groups' },
        ],
      },
      {
        id: 'sections',
        label: 'Sections',
        to: '/admin/sections',
        children: [
          { id: 'sections-list', label: 'Sections', to: '/admin/sections' },
          { id: 'pinned', label: 'Pinned topics', to: '/admin/sections/pinned' },
        ],
      },
      { id: 'files', label: 'Files', to: '/admin/images' },
    ],
  },
  {
    id: 'operations',
    heading: 'Operations',
    items: [
      { id: 'data', label: 'Data', to: '/admin/data' },
      { id: 'sources', label: 'Sources', to: '/admin/repos', badge: 'sources' },
      {
        id: 'health',
        label: 'Health',
        // As the Health tab did: the instance verdict is the question the badge
        // raises, so the item opens on it.
        to: '/admin/health/system',
        badge: 'health',
        children: [
          { id: 'health-content', label: 'Content', to: '/admin/health', pageLabel: 'Content health' },
          { id: 'health-system', label: 'System', to: '/admin/health/system', pageLabel: 'System health' },
        ],
      },
    ],
  },
];

export interface ActiveAdminNav {
  group: AdminNavGroup;
  item: AdminNavItem;
  /** The active child, when the item has children. */
  child: AdminNavLink | null;
}

/** `/admin/users/` and `/admin/users` are one page. */
function normalize(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** `to` matches `pathname` exactly, or as a whole-segment prefix (`/admin/health` of `/admin/health/x`, not of `/admin/healthy`). */
function matchLength(link: AdminNavLink, pathname: string): number {
  if (pathname === link.to) return link.to.length;
  if (link.exact) return -1;
  return pathname.startsWith(`${link.to}/`) ? link.to.length : -1;
}

/**
 * The group, item and child that own `pathname`, or null for a path outside
 * the admin console. A parent's own `to` never competes with its children: the
 * parent is active exactly when one of them is.
 */
export function resolveActiveAdminNav(pathname: string): ActiveAdminNav | null {
  const path = normalize(pathname);
  let best: ActiveAdminNav | null = null;
  let bestLength = -1;
  for (const group of ADMIN_NAV) {
    for (const item of group.items) {
      const candidates: { child: AdminNavLink | null; link: AdminNavLink }[] = item.children
        ? item.children.map((child) => ({ child, link: child }))
        : [{ child: null, link: item }];
      for (const { child, link } of candidates) {
        const length = matchLength(link, path);
        if (length > bestLength) {
          best = { group, item, child };
          bestLength = length;
        }
      }
    }
  }
  return best;
}

/** What the phone switcher names as the current page: the child's page label, else the item's. */
export function adminPageLabel(active: ActiveAdminNav | null): string {
  if (!active) return 'Overview';
  const link = active.child ?? active.item;
  return link.pageLabel ?? link.label;
}

/**
 * Open merge conflicts across every source, for the Sources badge. A source in
 * the `conflict` state that did not list its paths still counts as one — the
 * badge's job is "there is something to resolve", and zero would hide it.
 */
export function countOpenConflicts(sources: readonly Pick<SourceStatusView, 'status'>[] | undefined): number {
  if (!sources) return 0;
  return sources.reduce((sum, source) => {
    const paths = source.status?.conflicted_paths?.length ?? 0;
    if (paths > 0) return sum + paths;
    return sum + (source.status?.state === 'conflict' ? 1 : 0);
  }, 0);
}

/** Sources that name a host token or webhook secret the server does not have. Presence-only, as the wire is. */
export function countMissingSecrets(
  sources: readonly Pick<SourceStatusView, 'host_token_env' | 'host_token_present' | 'webhook_secret_env' | 'webhook_secret_present'>[] | undefined,
): number {
  if (!sources) return 0;
  // `=== false`, not falsy: a server that predates the flags omits them, and
  // "absent" must not read as "not set" (see describeSecrets).
  return sources.filter(
    (s) => (s.host_token_env && s.host_token_present === false) || (s.webhook_secret_env && s.webhook_secret_present === false),
  ).length;
}

/** The Health badge shows while the instance verdict is anything but healthy. Unknown (not loaded, 403) shows nothing. */
export function healthNeedsAttention(verdict: SystemVerdict | undefined): boolean {
  return verdict !== undefined && verdict !== 'healthy';
}
