/**
 * AdminHome — Admin → Overview (the admin UX review §4.9).
 *
 * It replaces a static card directory, which duplicated the nav and said
 * nothing about the instance, with two things the nav cannot say: what needs
 * attention right now, and a one-line status per destination.
 *
 * Cost discipline: every count comes from a query a destination page already
 * makes, under the same key, so opening a page after the Overview reuses the
 * cache and no endpoint was added. The one expensive report — content health,
 * a scan over the library — is read ONLY IF IT IS ALREADY CACHED (`skipToken`):
 * the Overview never starts it, and says so when it has nothing to show.
 *
 * What the page says lives in adminOverviewModel.ts (attention, grouping,
 * labels, counts); this file only gathers the queries and renders.
 */
import { Link } from '@tanstack/react-router';
import { skipToken, useQuery } from '@tanstack/react-query';
import { AdminPageHeader } from '../components/admin/AdminPageHeader.js';
import { StatusChip } from '../components/admin/StatusChip.js';
import { countOpenConflicts } from '../components/admin/AdminNav.model.js';
import { useAccess, useGroups, useImages, usePrimaryCategories, useSections, useTags, useTopics, useUserCounts } from '../queries.js';
import { useSources } from '../features/sources/queries.js';
import { useAdminTokensPage } from '../features/tokens/queries.js';
import { useSystemHealth, type ContentHealthReport } from '../features/health/queries.js';
import { buildAttention, buildShortcutGroups, queuedTotal, type OverviewGroup } from './adminOverviewModel.js';
import './AdminHome.css';

function ShortcutGroup({ group }: { group: OverviewGroup }) {
  const headingId = `admin-overview-${group.id}`;
  return (
    <section className="AdminOverview__group" aria-labelledby={headingId} data-group={group.id}>
      <h2 id={headingId} className="AdminOverview__groupHeading">
        {group.heading}
      </h2>
      <ul className="AdminOverview__shortcuts">
        {group.shortcuts.map((s) => (
          <li key={s.id} className="AdminOverview__shortcut" data-shortcut={s.id}>
            <span className="AdminOverview__shortcutHead">
              <Link to={s.to} className="AdminOverview__shortcutLink">
                {s.label}
              </Link>
              {s.status !== undefined ? <span className="AdminOverview__shortcutStatus">{s.status}</span> : null}
            </span>
            <span className="AdminOverview__shortcutDescription">{s.description}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AdminHome() {
  const system = useSystemHealth();
  const sources = useSources();
  // Read-through only: the report if some visit to Content health left it in
  // the cache, otherwise nothing — and no request.
  const contentHealth = useQuery<ContentHealthReport>({ queryKey: ['content-health', ''], queryFn: skipToken });
  // The users list is server-paged (50 a page), so count from its total, not a page length.
  const users = useUserCounts();
  // The same query (and key) the API tokens page heads itself with.
  const activeTokens = useAdminTokensPage({ state: 'active', limit: 1 });
  const access = useAccess();
  const topics = useTopics();
  const categories = usePrimaryCategories();
  const tags = useTags();
  const groups = useGroups();
  const sections = useSections();
  const files = useImages();

  const attention = buildAttention({ system: system.data, sources: sources.data, contentHealth: contentHealth.data });
  // "Everything looks healthy" is a claim; make it only once both live checks have answered.
  const checking = system.isLoading || sources.isLoading;

  const shortcutGroups = buildShortcutGroups({
    accounts: users.accounts,
    readMode: access.data,
    activeTokens: activeTokens.data?.total,
    topics: topics.data?.length,
    categories: categories.data?.length,
    tags: tags.data?.length,
    groups: groups.data?.length,
    sections: sections.data?.length,
    files: files.data?.length,
    orphanedFiles: files.data?.filter((f) => f.orphan).length,
    sources: sources.data?.length,
    openConflicts: sources.data ? countOpenConflicts(sources.data) : undefined,
    verdict: system.data?.verdict,
    queued: contentHealth.data ? queuedTotal(contentHealth.data) : undefined,
  });

  return (
    <main className="AdminHome AdminOverview" aria-labelledby="admin-home-title">
      <AdminPageHeader
        titleId="admin-home-title"
        title="Admin console"
        description={
          <>
            What needs attention on this instance, then every admin page; personal preferences live in your{' '}
            <Link to="/profile">profile</Link>.
          </>
        }
      />

      <section className="AdminOverview__attention" aria-labelledby="admin-attention-title">
        <h2 id="admin-attention-title" className="AdminOverview__sectionTitle">
          Needs attention
        </h2>
        {attention.length > 0 ? (
          <ul className="AdminOverview__attentionList">
            {attention.map((item) => (
              <li key={item.id} className="AdminOverview__attentionItem" data-tone={item.tone} data-attention={item.id}>
                {/* The tone is words and an icon as well as colour (StatusChip). */}
                <StatusChip tone={item.tone === 'alert' ? 'error' : 'warn'} label={item.tone === 'alert' ? 'Act now' : 'Check'} size="sm" />
                <span className="AdminOverview__attentionText">
                  <Link to={item.to} search={item.search as never}>
                    {item.label}
                  </Link>
                  {item.detail ? <span className="AdminOverview__attentionDetail">{item.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : checking ? (
          <p className="AdminOverview__muted" role="status">
            Checking…
          </p>
        ) : (
          <p className="AdminOverview__clear">
            <StatusChip tone="ok" label="Everything looks healthy" />
          </p>
        )}
        {!contentHealth.data ? (
          <p className="AdminOverview__note">
            Content health is not included until its report has been run —{' '}
            <Link to="/admin/health">open content health</Link>.
          </p>
        ) : null}
      </section>

      <div className="AdminOverview__groups">
        {shortcutGroups.map((group) => (
          <ShortcutGroup key={group.id} group={group} />
        ))}
      </div>
    </main>
  );
}
