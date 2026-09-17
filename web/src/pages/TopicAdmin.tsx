/**
 * TopicAdmin — `/admin/topics`: the read-only Topic catalog
 * (the admin UX review §4.5).
 *
 * This replaced a table with Rename and Archive buttons on every row and a
 * rename dialog that had grown to seven fields — presentation, Start here as a
 * typed slug, landing markdown in a bare textarea. Now nothing commits from a
 * row (§3.3): the name opens the dedicated edit page (`TopicEditPage`), and the
 * `⋯` menu holds the rest. Archive asks first, and when the server would refuse
 * it (the topic has items, or is the default topic) the menu says why in text.
 *
 * Search and the All · Private · Empty chips live in the query string, so a
 * filtered catalog is a link and Back undoes a filter. The list is small (one
 * row per topic), so filtering is client-side over `GET /topics`.
 *
 * Home topic and Pinned badges come from hooks the admin shell already caches
 * (`useSiteConfig`, `usePinnedTopics`), so they cost no extra request on a warm
 * session.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { AdminPageHeader } from '../components/admin/AdminPageHeader.js';
import { ConfirmDialog } from '../components/admin/ConfirmDialog.js';
import { DataTable, type DataTableColumn } from '../components/admin/DataTable.js';
import { EmptyState } from '../components/admin/EmptyState.js';
import type { OverflowMenuItem } from '../components/admin/OverflowMenu.js';
import { StatusChip } from '../components/admin/StatusChip.js';
import { usePinnedTopics } from '../components/shell/SiteBrand.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { pushToast } from '../hooks/useToast.js';
import { Icon, appIcons } from '../icons.js';
import { pickHomeTopic } from '../features/topic/slots.js';
import { useSiteConfig, type TopicListEntry } from '../features/topic/queries.js';
import { NewTopicDialog } from '../features/topics-admin/NewTopicDialog.js';
import {
  TOPIC_FILTERS,
  archiveBlockedReason,
  archiveConsequences,
  filterTopics,
  plural,
  presentationLabel,
  readTopicsSearch,
  topicDisplayName,
  topicFilterCounts,
  topicItemCount,
  topicVisibility,
  writeTopicsSearch,
  type TopicsSearch,
} from '../features/topics-admin/topicsAdminModel.js';
import { useArchiveTopic, useTopics } from '../queries.js';
import './TopicAdmin.css';

const SEARCH_DEBOUNCE_MS = 250;

export function TopicAdmin(): JSX.Element {
  const navigate = useNavigate();
  const search = readTopicsSearch(useSearch({ strict: false }) as Record<string, unknown> | undefined);
  const { data: topicsData, isLoading, isError, refetch } = useTopics();
  const { data: site } = useSiteConfig();
  const { data: pins } = usePinnedTopics();
  const archiveTopic = useArchiveTopic();
  const [creating, setCreating] = useState(false);
  const [pendingArchive, setPendingArchive] = useState<TopicListEntry | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const topics = useMemo(() => (topicsData ?? []) as TopicListEntry[], [topicsData]);
  const homeSlug = topics.length ? pickHomeTopic(topics, site?.home_topic)?.slug : undefined;
  const pinnedSlugs = useMemo(() => new Set((pins ?? []).map((p) => p.topic)), [pins]);

  const go = (next: TopicsSearch, replace = false) => {
    void navigate({ to: '/admin/topics', search: writeTopicsSearch(next) as never, replace });
  };

  // Search: typed locally, written to the URL after a pause with `replace`, so
  // a typed word is one history entry. `pushedQ` tells our own navigation
  // apart from an outside one (Back, a pasted link), which must reach the box.
  const [qInput, setQInput] = useState(search.q);
  const debouncedQ = useDebouncedValue(qInput, SEARCH_DEBOUNCE_MS);
  const pushedQ = useRef(search.q);
  useEffect(() => {
    if (debouncedQ.trim() === search.q.trim()) return;
    pushedQ.current = debouncedQ.trim();
    go({ ...search, q: debouncedQ }, true);
    // Only the debounced text should trigger this; `search` is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);
  useEffect(() => {
    if (search.q.trim() !== pushedQ.current) {
      pushedQ.current = search.q.trim();
      setQInput(search.q);
    }
  }, [search.q]);

  const counts = topicFilterCounts(topics);
  const rows = filterTopics(topics, { ...search, q: qInput });
  const hasFilters = qInput.trim() !== '' || search.filter !== 'all';

  async function confirmArchive() {
    if (!pendingArchive) return;
    const topic = pendingArchive;
    setArchiveError(null);
    try {
      await archiveTopic.mutateAsync(topic.id);
      setPendingArchive(null);
      pushToast({ kind: 'success', message: `Topic archived: ${topicDisplayName(topic)}` });
    } catch (error) {
      setArchiveError((error as { message?: string })?.message || 'The topic could not be archived. Nothing was changed.');
    }
  }

  const rowActions = (topic: TopicListEntry): OverflowMenuItem[] => [
    { id: 'edit', label: 'Edit', onSelect: () => void navigate({ to: '/admin/topics/$slug', params: { slug: topic.slug } }) },
    { id: 'view', label: 'View landing page', onSelect: () => void navigate({ to: '/topics/$slug', params: { slug: topic.slug } }) },
    {
      id: 'archive',
      label: 'Archive…',
      danger: true,
      separatorBefore: true,
      disabledReason: archiveBlockedReason(topic) ?? undefined,
      onSelect: () => {
        setArchiveError(null);
        setPendingArchive(topic);
      },
    },
  ];

  const columns: DataTableColumn<TopicListEntry>[] = [
    {
      id: 'topic',
      header: 'Topic',
      primary: true,
      sortValue: (t) => topicDisplayName(t),
      cell: (t) => (
        <span className="TopicCatalog__name">
          <span className="TopicCatalog__nameLine">
            <span className="TopicCatalog__nameText">{topicDisplayName(t)}</span>
            {t.slug === homeSlug ? <StatusChip tone="info" size="sm" label="Home topic" title="Its sections also appear on the front page" /> : null}
            {pinnedSlugs.has(t.slug) ? <StatusChip tone="info" size="sm" label="Pinned" title="Featured on the home page" /> : null}
          </span>
          {t.description?.trim() ? <span className="TopicCatalog__description">{t.description}</span> : null}
        </span>
      ),
    },
    { id: 'presentation', header: 'Presentation', hideBelow: 'md', sortValue: (t) => presentationLabel(t.presentation), cell: (t) => presentationLabel(t.presentation) },
    {
      id: 'visibility',
      header: 'Visibility',
      sortValue: (t) => topicVisibility(t),
      cell: (t) =>
        topicVisibility(t) === 'private' ? (
          <StatusChip tone="warn" size="sm" label="Private" title="Hidden from anonymous visitors. Signed-in users are unaffected." />
        ) : (
          <span className="TopicCatalog__muted">Public</span>
        ),
    },
    {
      id: 'items',
      header: 'Items',
      align: 'end',
      sortValue: (t) => topicItemCount(t),
      cell: (t) => {
        const n = topicItemCount(t);
        if (n === 0) return <span className="TopicCatalog__muted">0 items</span>;
        return (
          <Link to="/search" search={{ topic: t.slug } as never} className="TopicCatalog__itemsLink" aria-label={`${plural(n, 'item')} in ${topicDisplayName(t)}`}>
            {plural(n, 'item')}
          </Link>
        );
      },
    },
  ];

  const toolbar = (
    <div className="TopicCatalog__toolbar" role="search" aria-label="Filter topics">
      <input
        className="TopicCatalog__search"
        type="search"
        value={qInput}
        onChange={(e) => setQInput(e.target.value)}
        placeholder="Search topics…"
        aria-label="Search topics"
      />
      <div className="TopicCatalog__chips" role="group" aria-label="Show">
        {TOPIC_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            className="TopicCatalog__chip"
            aria-pressed={search.filter === f.value}
            onClick={() => go({ ...search, q: qInput, filter: f.value })}
          >
            {f.label} <span className="TopicCatalog__chipCount">{counts[f.value]}</span>
          </button>
        ))}
      </div>
    </div>
  );

  const newTopicButton = (
    <button type="button" className="kp-admin-button kp-admin-button--primary" onClick={() => setCreating(true)}>
      <Icon icon={appIcons.plus} /> New topic
    </button>
  );

  return (
    <main className="TopicCatalog" aria-labelledby="topic-admin-title">
      <AdminPageHeader
        titleId="topic-admin-title"
        title="Topics"
        description="The top-level homes for items, each with its own landing page."
        meta={topicsData ? `${plural(topics.length, 'topic')}${counts.private ? ` · ${counts.private} private` : ''}` : undefined}
        primaryAction={newTopicButton}
        learnMore={
          <details>
            <summary>How topics work</summary>
            <p>
              Every item belongs to one topic. A topic&apos;s landing page, <code>/topics/&lt;slug&gt;</code>, is shaped by its
              presentation and lists the sections that name it. Private hides a topic and its items from visitors who are not
              signed in; it does not restrict signed-in users. A topic can only be archived once no items are assigned to it,
              and an item&apos;s topic is not changed from the article editor.
            </p>
          </details>
        }
      />

      <DataTable<TopicListEntry>
        rows={rows}
        rowKey={(t) => t.id}
        rowLabel={(t) => topicDisplayName(t)}
        columns={columns}
        caption="Topics"
        state={isError ? 'error' : isLoading ? 'loading' : 'ready'}
        errorMessage="Topics could not be loaded."
        onRetry={() => void refetch()}
        rowHref={(t) => `/admin/topics/${encodeURIComponent(t.slug)}`}
        rowActions={rowActions}
        toolbar={topics.length > 0 ? toolbar : undefined}
        empty={
          hasFilters && topics.length > 0 ? (
            <EmptyState
              title="No topics match"
              body="Try another search, or show all topics."
              action={
                <button
                  type="button"
                  className="kp-admin-button"
                  onClick={() => {
                    pushedQ.current = '';
                    setQInput('');
                    go({ q: '', filter: 'all' });
                  }}
                >
                  Clear filters
                </button>
              }
            />
          ) : (
            <EmptyState title="No topics yet" body="A topic gathers related items under one landing page." action={newTopicButton} />
          )
        }
      />

      {creating ? (
        <NewTopicDialog
          existing={topics}
          onClose={() => setCreating(false)}
          onCreated={(topic, message) => {
            setCreating(false);
            pushToast({ kind: 'success', message });
            void navigate({ to: '/admin/topics/$slug', params: { slug: topic.slug } });
          }}
        />
      ) : null}

      {pendingArchive ? (
        <ConfirmDialog
          title={`Archive ${topicDisplayName(pendingArchive)}?`}
          body="The topic is removed from the site straight away."
          consequences={archiveConsequences(pendingArchive)}
          confirmLabel="Archive topic"
          tone="danger"
          pending={archiveTopic.isPending}
          error={archiveError}
          onConfirm={() => void confirmArchive()}
          onCancel={() => setPendingArchive(null)}
        />
      ) : null}
    </main>
  );
}
