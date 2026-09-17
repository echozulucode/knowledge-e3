/**
 * The admin Overview's "Needs attention" list and its grouped shortcuts
 * (the admin UX review §4.9), decided here without React or the
 * network so what does and does not make the list — and which label, path and
 * count each shortcut carries — is unit-tested.
 *
 * Every input is optional because each comes from a different query that may be
 * loading, refused (403) or — for content health — deliberately never fetched
 * by this page. Absent input contributes nothing; it never reads as "all clear"
 * on its own, which is why the page also says when content health was not
 * consulted.
 */
import type { ContentHealthReport } from '../features/health/queries.js';
import type { ReadAccessMode } from '../queries.js';
import type { SourceStatusView } from '../features/sources/types.js';
import { VERDICT_LABELS, verdictReason, type SystemHealthReport } from '../features/health/systemVerdict.js';
import { ADMIN_NAV, countMissingSecrets, countOpenConflicts, type AdminNavLink } from '../components/admin/AdminNav.model.js';

export type AttentionTone = 'warn' | 'alert';

export interface AttentionItem {
  id: string;
  tone: AttentionTone;
  /** The link text: what is wrong, with its count. */
  label: string;
  /** One line of context under it, when there is one. */
  detail?: string;
  to: string;
  /** Search params for `to`: a deep link into the page (e.g. the one source's Conflicts tab). */
  search?: Record<string, string>;
}

export interface AttentionInputs {
  system?: Pick<SystemHealthReport, 'verdict' | 'checks'>;
  sources?: readonly SourceStatusView[];
  /** Only ever a report that was ALREADY cached; the Overview never pays for the scan. */
  contentHealth?: Pick<ContentHealthReport, 'queues'>;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Worst first: an at-risk instance, then sync conflicts, then everything that is only a warning. */
export function buildAttention({ system, sources, contentHealth }: AttentionInputs): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (system && system.verdict !== 'healthy') {
    items.push({
      id: 'system',
      tone: system.verdict === 'at_risk' ? 'alert' : 'warn',
      label: `System health: ${VERDICT_LABELS[system.verdict]}`,
      detail: verdictReason(system),
      to: '/admin/health/system',
    });
  }

  const conflicts = countOpenConflicts(sources);
  if (conflicts > 0 && sources) {
    const blocked = sources.filter((s) => (s.status?.conflicted_paths?.length ?? 0) > 0 || s.status?.state === 'conflict').map((s) => s.id);
    items.push({
      id: 'conflicts',
      tone: 'alert',
      label: plural(conflicts, 'open sync conflict', 'open sync conflicts'),
      detail: `Blocking ${blocked.join(', ')}.`,
      to: '/admin/repos',
      // One blocked source: straight to its Conflicts tab. Several: the list,
      // filtered to what needs attention.
      search: blocked.length === 1 ? { source: blocked[0]!, tab: 'conflicts' } : { state: 'attention' },
    });
  }

  const missing = countMissingSecrets(sources);
  if (missing > 0) {
    items.push({
      id: 'secrets',
      tone: 'warn',
      label: `${plural(missing, 'source is', 'sources are')} missing a host token or webhook secret`,
      detail: 'Named in the registry but not set in the server environment.',
      to: '/admin/repos',
      search: { state: 'attention' },
    });
  }

  if (contentHealth) {
    const q = contentHealth.queues;
    const lint = q.lint_failed_inbound?.count ?? 0;
    const declined = q.declined_removal_still_deleted?.count ?? 0;
    const stale = q.stale?.count ?? 0;
    // Each opens Content health on its own queue (`?queue=`), not on the page top.
    if (lint > 0) {
      items.push({ id: 'lint', tone: 'warn', label: `${plural(lint, 'item', 'items')} arrived with lint errors`, to: '/admin/health', search: { queue: 'lint_failed_inbound' } });
    }
    if (declined > 0) {
      items.push({
        id: 'declined',
        tone: 'warn',
        label: `${plural(declined, 'declined removal is', 'declined removals are')} still deleted here`,
        to: '/admin/health',
        search: { queue: 'declined_removal_still_deleted' },
      });
    }
    if (stale > 0) items.push({ id: 'stale', tone: 'warn', label: `${plural(stale, 'stale item', 'stale items')}`, to: '/admin/health', search: { queue: 'stale' } });
  }

  // Stable sort: alerts ahead of warnings, insertion order otherwise.
  return items.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'alert' ? -1 : 1));
}

/** Items waiting in any content-health queue, for the Overview's shortcut line. */
export function queuedTotal(report: Pick<ContentHealthReport, 'queues'>): number {
  return Object.values(report.queues).reduce((sum, queue) => sum + (queue?.count ?? 0), 0);
}

/* ------------------------------------------------------------ shortcut groups */

/**
 * Which nav destinations the Overview offers, per nav group, in nav order.
 * By nav ID, never by label: the label, the path and the heading are all read
 * from ADMIN_NAV, so a shortcut cannot drift from the nav it mirrors. Two
 * choices are deliberate: Authentication's and Taxonomy's children are offered
 * individually (API tokens and Tags & groups are destinations an admin comes
 * for by name, and "Taxonomy" alone opens Topics), while Sections and Health are
 * offered once, as the nav item — Pinned topics is a tab of Sections, and
 * Health opens on the verdict and carries both halves' status on one line.
 */
export const OVERVIEW_SHORTCUT_IDS: Readonly<Record<'people' | 'content' | 'operations', readonly string[]>> = {
  people: ['users', 'auth-settings', 'tokens', 'audit'],
  content: ['topics', 'categories', 'tags-groups', 'sections', 'files'],
  operations: ['data', 'sources', 'health'],
};

/** One line under each shortcut saying what the page is for. */
const SHORTCUT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  users: 'Invite and manage accounts, assign roles, disable access, and reset passwords.',
  // D8: this entry once promised SSO (OIDC/SAML) and LDAP. Neither exists.
  'auth-settings': 'Who can read content, the local password policy, and how long API tokens may live.',
  tokens: 'Every personal access token on this instance: its owner, scope and expiry.',
  audit: 'Who changed what, and when: sign-ins, role changes, tokens, configuration, sources, imports and exports.',
  topics: 'The topic catalog used to organize items.',
  categories: 'The primary category catalog used by item metadata.',
  'tags-groups': 'Tag usage, and the global or Topic-scoped groups item editing picks from.',
  sections: 'The home page sections and pinned topics.',
  files: 'Uploaded files and attachments, with orphans flagged.',
  data: 'Export the library as an OKF bundle, or import one.',
  sources: 'Every repository working tree this instance indexes, its sync policy, conflicts, and reviews.',
  health: 'One verdict over the database, disk, sources, git mirror and restore drill, and the library’s fix-it queues.',
};

/**
 * Counts and states for the shortcut lines. Every field is optional: each comes
 * from its own query, which may be loading or refused, and a missing value
 * omits the line rather than showing a zero that is not true.
 */
export interface OverviewCounts {
  accounts?: number;
  readMode?: ReadAccessMode;
  activeTokens?: number;
  topics?: number;
  categories?: number;
  tags?: number;
  groups?: number;
  sections?: number;
  files?: number;
  orphanedFiles?: number;
  sources?: number;
  openConflicts?: number;
  verdict?: SystemHealthReport['verdict'];
  /** Only from an ALREADY cached content-health report (see AdminHome). */
  queued?: number;
}

export interface OverviewShortcut {
  id: string;
  /** The nav label, verbatim. */
  label: string;
  to: string;
  description: string;
  status?: string;
}

export interface OverviewGroup {
  id: keyof typeof OVERVIEW_SHORTCUT_IDS;
  heading: string;
  shortcuts: OverviewShortcut[];
}

const countOf = (n: number | undefined, one: string, many: string): string | undefined =>
  n === undefined ? undefined : plural(n, one, many);

/** "a · b", skipping the parts that are unknown; undefined when every part is. */
const joined = (...parts: (string | undefined | false)[]): string | undefined => {
  const known = parts.filter((p): p is string => Boolean(p));
  return known.length > 0 ? known.join(' · ') : undefined;
};

function statusFor(id: string, c: OverviewCounts): string | undefined {
  switch (id) {
    case 'users':
      return countOf(c.accounts, 'account', 'accounts');
    case 'auth-settings':
      return c.readMode === undefined ? undefined : c.readMode === 'public' ? 'Content is public' : 'Login required to read';
    case 'tokens':
      return countOf(c.activeTokens, 'active token', 'active tokens');
    case 'topics':
      return countOf(c.topics, 'topic', 'topics');
    case 'categories':
      return countOf(c.categories, 'category', 'categories');
    case 'tags-groups':
      // Both or neither: "12 tags" alone would read as "and no groups".
      return c.tags === undefined || c.groups === undefined
        ? undefined
        : joined(countOf(c.tags, 'tag', 'tags'), countOf(c.groups, 'group', 'groups'));
    case 'sections':
      return countOf(c.sections, 'section', 'sections');
    case 'files':
      return c.files === undefined ? undefined : joined(countOf(c.files, 'file', 'files'), (c.orphanedFiles ?? 0) > 0 && `${c.orphanedFiles} orphaned`);
    case 'sources':
      return c.sources === undefined
        ? undefined
        : joined(countOf(c.sources, 'source', 'sources'), (c.openConflicts ?? 0) > 0 && plural(c.openConflicts!, 'open conflict', 'open conflicts'));
    case 'health':
      return joined(c.verdict && `System: ${VERDICT_LABELS[c.verdict]}`, c.queued !== undefined && `${c.queued} in fix-it queues`);
    default:
      return undefined;
  }
}

function findNavLink(id: string): AdminNavLink | undefined {
  for (const group of ADMIN_NAV) {
    for (const item of group.items) {
      if (item.id === id) return item;
      const child = item.children?.find((c) => c.id === id);
      if (child) return child;
    }
  }
  return undefined;
}

/** The Overview's three shortcut columns, mirroring the nav's groups, headings and labels. */
export function buildShortcutGroups(counts: OverviewCounts): OverviewGroup[] {
  return (Object.keys(OVERVIEW_SHORTCUT_IDS) as OverviewGroup['id'][]).map((groupId) => ({
    id: groupId,
    heading: ADMIN_NAV.find((g) => g.id === groupId)?.heading ?? groupId,
    shortcuts: OVERVIEW_SHORTCUT_IDS[groupId].flatMap((id) => {
      const link = findNavLink(id);
      if (!link) return [];
      const status = statusFor(id, counts);
      return [{ id, label: link.label, to: link.to, description: SHORTCUT_DESCRIPTIONS[id] ?? '', ...(status !== undefined ? { status } : {}) }];
    }),
  }));
}
