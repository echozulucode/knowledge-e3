/**
 * SectionsAdmin — `/admin/sections`: the read-only list of curated Sections
 * (the admin UX review §4.1).
 *
 * This replaced an editable grid of ten text inputs per section, which Eric
 * rejected ("not scalable if there are more attributes added … there should be
 * a separate add/edit page"). The list now only READS: a row opens the
 * dedicated edit page (`SectionEditPage`), and the only writes here are the
 * two that are about the list itself — order and delete — which save at once
 * with Undo (review §3.3) instead of waiting for a page-wide Save.
 *
 * Grouped by where a section appears, because that is what decides what it
 * does: a cross-topic section belongs to the front page, a topic's to that
 * topic's landing. Two facts the old grid hid are shown on the row:
 *   - LEAD: the lowest-ordered front-page section that matches anything leads
 *     the front page (features/topic/slots.ts `pickUpdatesSection`);
 *   - "0 items": the server drops a section that matches nothing, so it is
 *     silently absent from the site. The row says so.
 *
 * Match counts cost one `/pages?limit=1` each, queued at most four at a time
 * and cached for a minute (queries.ts `matchCountQueryOptions`).
 *
 * Reordering is per placement group: one table per group, each with its own
 * `useReorder`, so a keyboard grab can never carry a section into another
 * group (a topic change is an edit, made on the edit page).
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { AdminPageHeader } from '../components/admin/AdminPageHeader.js';
import { ConfirmDialog } from '../components/admin/ConfirmDialog.js';
import { DataTable, type DataTableColumn } from '../components/admin/DataTable.js';
import { EmptyState } from '../components/admin/EmptyState.js';
import { useReorder } from '../components/admin/ReorderList.js';
import { StatusChip } from '../components/admin/StatusChip.js';
import { pushToast } from '../hooks/useToast.js';
import { Icon, appIcons } from '../icons.js';
import { SLOT_HEADINGS, pickHomeTopic } from '../features/topic/slots.js';
import { useSiteConfig, type TopicListEntry } from '../features/topic/queries.js';
import { matchCountQueryOptions, useContentTypes, useSections, useTopics, useUpdateSections, type ContentType, type Section } from '../queries.js';
import {
  FRONT_PAGE_KEY,
  SECTION_DEFAULT_LIMIT,
  ZERO_MATCHES_TITLE,
  applyGroupOrder,
  deleteConsequences,
  filterSections,
  findContentTypeLabel,
  groupSections,
  leadSlug,
  matchFilters,
  placementName,
  removeSection,
  restoreOrders,
  restoreSection,
  slotApplies,
  type PlacementGroup,
  type TopicRef,
} from './sectionsAdminModel.js';
import './SectionsAdmin.css';

/** "Sections · Pinned topics" — the two pages of this nav entry, for widths where the admin nav hides children. */
export function SectionsSubnav({ current }: { current: 'sections' | 'pinned' }): JSX.Element {
  return (
    <nav className="SectionsAdmin__subnav" aria-label="Sections pages">
      <Link to="/admin/sections" aria-current={current === 'sections' ? 'page' : undefined} activeOptions={{ exact: true }}>
        Sections
      </Link>
      <span aria-hidden="true">·</span>
      <Link to="/admin/sections/pinned" aria-current={current === 'pinned' ? 'page' : undefined}>
        Pinned topics
      </Link>
    </nav>
  );
}

/** Content type label for a stored `type` (key or label, any case), "Any" when unset, the raw value when unknown. */
export function contentTypeLabel(type: string | undefined, types: readonly ContentType[] | undefined): string {
  if (!type?.trim()) return 'Any';
  return findContentTypeLabel(type, types) ?? type;
}

/** Toast after an immediate save, with Undo (an action toast stays at least 8 s, useToast.ts). */
function toastWithUndo(message: string, onUndo: () => void): void {
  pushToast({ kind: 'success', message, action: { label: 'Undo', onAction: onUndo } });
}

function undoFailed(): void {
  pushToast({ kind: 'error', message: 'Undo failed. Reload the page to see what is saved.' });
}

export function SectionsAdmin(): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: sections, isLoading, isError, refetch } = useSections();
  const { data: topicsData } = useTopics();
  const { data: site } = useSiteConfig();
  const { data: contentTypes } = useContentTypes();
  const update = useUpdateSections();
  const [query, setQuery] = useState('');
  const [placement, setPlacement] = useState('all');
  const [pendingDelete, setPendingDelete] = useState<Section | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const topics = useMemo<TopicRef[]>(() => (topicsData ?? []) as TopicListEntry[], [topicsData]);
  const homeTopicSlug = pickHomeTopic(topics, site?.home_topic)?.slug;
  const all = useMemo(() => sections ?? [], [sections]);

  const counts = useQueries({ queries: all.map((s) => matchCountQueryOptions(matchFilters(s))) });
  const countBySlug = useMemo(() => {
    const out: Record<string, number | undefined> = {};
    all.forEach((s, i) => {
      out[s.slug] = counts[i]?.data;
    });
    return out;
    // `counts` is a new array each render; its data values are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, counts.map((c) => c.data).join(',')]);
  const lead = leadSlug(all, countBySlug);

  const visible = filterSections(all, topics, { query, placement });
  const groups = groupSections(visible, topics, homeTopicSlug);
  const placements = groupSections(all, topics, homeTopicSlug);
  const searching = query.trim() !== '';

  /**
   * Reorder one group: optimistic in the cache so the row moves under the
   * pointer, then written against the list as stored now. Undo puts back the
   * exact orders the group had.
   */
  function reorderGroup(orderedSlugs: string[]) {
    const previous = queryClient.getQueryData<Section[]>(['sections']);
    queryClient.setQueryData<Section[]>(['sections'], (current) => (current ? applyGroupOrder(current, orderedSlugs) : current));
    update.mutate((current) => applyGroupOrder(current, orderedSlugs), {
      onSuccess: ({ before }) => {
        toastWithUndo('Order saved.', () => update.mutate((current) => restoreOrders(current, before, orderedSlugs), { onError: undoFailed }));
      },
      onError: () => {
        if (previous) queryClient.setQueryData(['sections'], previous);
        pushToast({ kind: 'error', message: 'The new order could not be saved.' });
      },
    });
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const removed = pendingDelete;
    setDeleteError(null);
    try {
      await update.mutateAsync((current) => removeSection(current, removed.slug));
      setPendingDelete(null);
      toastWithUndo(`Deleted “${removed.name}”.`, () => update.mutate((current) => restoreSection(current, removed), { onError: undoFailed }));
    } catch {
      setDeleteError('The section could not be deleted. Nothing was changed.');
    }
  }

  const columns: DataTableColumn<Section>[] = [
    {
      id: 'name',
      header: 'Name',
      primary: true,
      cell: (s) => (
        <span className="SectionsAdmin__name">
          <span className="SectionsAdmin__nameLine">
            <span className="SectionsAdmin__nameText">{s.name}</span>
            {s.slug === lead ? <StatusChip tone="info" size="sm" label="Lead" title="Leads the front page: the lowest-ordered front-page section that matches items" /> : null}
          </span>
          <span className="SectionsAdmin__slug">/sections/{s.slug}</span>
        </span>
      ),
    },
    { id: 'type', header: 'Type', cell: (s) => contentTypeLabel(s.type, contentTypes) },
    { id: 'placement', header: 'Topic', hideBelow: 'md', cell: (s) => placementName(s.space, topics) },
    {
      id: 'tags',
      header: 'Tags',
      hideBelow: 'lg',
      cell: (s) => {
        const tags = s.tags ?? [];
        if (tags.length === 0) return <span className="SectionsAdmin__muted">—</span>;
        return (
          <span className="SectionsAdmin__tags">
            {tags.slice(0, 2).map((t) => (
              <span key={t} className="SectionsAdmin__tag">
                {t}
              </span>
            ))}
            {tags.length > 2 ? <span className="SectionsAdmin__more" title={tags.slice(2).join(', ')}>+{tags.length - 2}</span> : null}
          </span>
        );
      },
    },
    {
      id: 'slot',
      header: 'Slot',
      hideBelow: 'lg',
      cell: (s) =>
        slotApplies(s.space, topics, homeTopicSlug) && s.slot && s.slot !== 'none' ? SLOT_HEADINGS[s.slot] : <span className="SectionsAdmin__muted">—</span>,
    },
    { id: 'limit', header: 'Limit', align: 'end', hideBelow: 'md', cell: (s) => s.limit ?? SECTION_DEFAULT_LIMIT },
    {
      id: 'matches',
      header: 'Matches',
      cell: (s) => {
        const n = countBySlug[s.slug];
        if (n === undefined) return <span className="SectionsAdmin__muted">…</span>;
        if (n === 0) return <StatusChip tone="warn" size="sm" label="0 items" title={ZERO_MATCHES_TITLE} />;
        return `${n} ${n === 1 ? 'item' : 'items'}`;
      },
    },
  ];

  const header = (
    <>
      <SectionsSubnav current="sections" />
      <AdminPageHeader
        titleId="sections-admin-title"
        title="Sections"
        description="Curated views of items by type, topic and tags, shown on the front page and topic landings."
        meta={sections ? `${sections.length} ${sections.length === 1 ? 'section' : 'sections'}` : undefined}
        primaryAction={
          <Link to="/admin/sections/new" className="kp-admin-button kp-admin-button--primary">
            <Icon icon={appIcons.plus} /> New section
          </Link>
        }
        learnMore={
          <details>
            <summary>How sections work</summary>
            <p>
              A section filters items by content type, topic and tags; the filters you set all apply together, and an item
              matches the tags if it carries any of them. A section with no topic spans every topic and appears on the front
              page only; the lowest-ordered one that matches anything leads the front page. A section with a topic appears on
              that topic&apos;s landing page (and on the front page, below the fold, when it is the home topic). Every section
              also has its own page at <code>/sections/&lt;slug&gt;</code>. A section that matches nothing is hidden on the site.
            </p>
          </details>
        }
      />
    </>
  );

  const toolbar = (
    <div className="SectionsAdmin__toolbar" role="search" aria-label="Filter sections">
      <label className="SectionsAdmin__filter">
        <span>Search</span>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search sections…" />
      </label>
      <label className="SectionsAdmin__filter">
        <span>Placement</span>
        <select value={placement} onChange={(e) => setPlacement(e.target.value)}>
          <option value="all">All</option>
          {placements.map((g) => (
            <option key={g.key} value={g.key}>
              {g.key === FRONT_PAGE_KEY ? 'Front page' : (g.topic?.name ?? g.key)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );

  let body: JSX.Element;
  if (isLoading || isError || all.length === 0) {
    body = (
      <DataTable<Section>
        rows={[]}
        rowKey={(s) => s.slug}
        columns={columns}
        caption="Sections"
        state={isLoading ? 'loading' : isError ? 'error' : 'ready'}
        errorMessage="Sections could not be loaded."
        onRetry={() => void refetch()}
        empty={
          <EmptyState
            title="No sections yet"
            body="A section gathers items by type, topic and tags — an Updates feed, a FAQ, best practices."
            action={
              <Link to="/admin/sections/new" className="kp-admin-button kp-admin-button--primary">
                <Icon icon={appIcons.plus} /> New section
              </Link>
            }
          />
        }
      />
    );
  } else {
    body = (
      <>
        {toolbar}
        {searching ? <p className="SectionsAdmin__hint">Clear the search to reorder sections.</p> : null}
        {groups.length === 0 ? (
          <EmptyState title="No sections match" body="Try another search or placement." />
        ) : (
          groups.map((group) => (
            <SectionGroupTable
              key={group.key}
              group={group}
              columns={columns}
              reorderDisabled={searching}
              onReorder={reorderGroup}
              actions={(section) => [
                { id: 'edit', label: 'Edit', onSelect: () => void navigate({ to: '/admin/sections/$slug', params: { slug: section.slug } }) },
                { id: 'view', label: 'View on site', onSelect: () => void navigate({ to: '/sections/$slug', params: { slug: section.slug } }) },
                { id: 'duplicate', label: 'Duplicate', onSelect: () => void navigate({ to: '/admin/sections/new', search: { from: section.slug } as never }) },
              ]}
              onDelete={(section) => {
                setDeleteError(null);
                setPendingDelete(section);
              }}
            />
          ))
        )}
      </>
    );
  }

  return (
    <main className="SectionsAdmin" aria-labelledby="sections-admin-title">
      {header}
      {body}
      {pendingDelete ? (
        <ConfirmDialog
          title={`Delete “${pendingDelete.name}”?`}
          body="The section is removed from the site straight away. You can undo from the message that follows."
          consequences={deleteConsequences(pendingDelete, topics, homeTopicSlug, pendingDelete.slug === lead)}
          confirmLabel="Delete section"
          tone="danger"
          pending={update.isPending}
          error={deleteError}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </main>
  );
}

function SectionGroupTable({
  group,
  columns,
  reorderDisabled,
  onReorder,
  actions,
  onDelete,
}: {
  group: PlacementGroup;
  columns: DataTableColumn<Section>[];
  reorderDisabled: boolean;
  onReorder: (orderedSlugs: string[]) => void;
  actions: (section: Section) => { id: string; label: string; onSelect: () => void }[];
  onDelete: (section: Section) => void;
}) {
  const headingId = `sections-group-${group.key}`;
  const reorder = useReorder<Section>({
    items: group.sections,
    getId: (s) => s.slug,
    itemLabel: (s) => s.name,
    onReorder,
    disabled: reorderDisabled,
  });
  const canReorder = group.sections.length > 1;

  return (
    <section className="SectionsAdmin__group" aria-labelledby={headingId} data-placement={group.key}>
      <div className="SectionsAdmin__groupHead">
        <h2 id={headingId} className="SectionsAdmin__groupTitle">
          {group.label}
        </h2>
        {canReorder && !reorderDisabled ? <span className="SectionsAdmin__groupHint">Drag, or use a handle with the arrow keys, to reorder</span> : null}
      </div>
      <DataTable<Section>
        rows={reorder.items}
        rowKey={(s) => s.slug}
        rowLabel={(s) => s.name}
        columns={columns}
        caption={group.label}
        rowHref={(s) => `/admin/sections/${encodeURIComponent(s.slug)}`}
        rowDecorator={canReorder ? (s) => reorder.handle(s) : undefined}
        rowActions={(s) => [
          ...actions(s),
          ...(canReorder ? reorder.moveMenuItems(s).map((item, i) => (i === 0 ? { ...item, separatorBefore: true } : item)) : []),
          { id: 'delete', label: 'Delete…', danger: true, separatorBefore: true, onSelect: () => onDelete(s) },
        ]}
      />
      {reorder.announcer}
    </section>
  );
}
