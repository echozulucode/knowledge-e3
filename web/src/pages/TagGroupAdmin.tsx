/**
 * TagGroupAdmin — `/admin/tags-groups` (the admin UX review §4.6).
 *
 * One page, two views behind a `Tags (N) | Groups (N)` switch kept in the URL
 * (`?view=groups`), so a link opens the view it was copied from.
 *
 * Tags are derived from item frontmatter; there is no safe rewrite flow for
 * them yet, so the page offers none — the old table carried three disabled
 * buttons on every row (411 of them on this instance) and now there is one
 * sentence saying rename and merge are not available. What a tag list is good
 * for today is spotting the long tail: search (on the server, debounced), sort
 * by usage or name, "Used by only 1 item", and a usage bar per row.
 *
 * Groups are admin-created and editable: row click or `⋯ → Edit…` opens the
 * group dialog; Archive… confirms, and is disabled with the reason in text
 * while items are in the group (the server refuses it too).
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Icon, appIcons } from '../icons.js';
import { AdminPageHeader } from '../components/admin/AdminPageHeader.js';
import { ConfirmDialog } from '../components/admin/ConfirmDialog.js';
import { DataTable, type DataTableColumn } from '../components/admin/DataTable.js';
import { EmptyState } from '../components/admin/EmptyState.js';
import type { OverflowMenuItem } from '../components/admin/OverflowMenu.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { useToast } from '../hooks/useToast.js';
import { useArchiveGroup, useGroups, useTags, useTopics, type TaxonomyGroup, type TaxonomyTag } from '../queries.js';
import { GroupDialog } from '../features/taxonomy-admin/GroupDialog.js';
import { ViewSwitch, viewPanelId, viewTabId } from '../features/taxonomy-admin/ViewSwitch.js';
import {
  arrangeTags,
  availableInLabel,
  errorText,
  itemsLabel,
  maxCount,
  pluralize,
  readTagGroupView,
  slugDiffersFromName,
  sortByName,
  usagePercent,
  viewSearch,
  type TagGroupView,
  type TagSort,
} from '../features/taxonomy-admin/taxonomyAdminModel.js';
import '../features/taxonomy-admin/TaxonomyAdmin.css';

const SEARCH_DEBOUNCE_MS = 300;
const TAGS_PAGE_SIZE = 50;
const VIEW_ID = 'tag-group-view';

export function TagGroupAdmin() {
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown> | undefined;
  const view = readTagGroupView(rawSearch);
  const setView = (next: TagGroupView) => {
    void navigate({ to: '/admin/tags-groups', search: viewSearch(next, 'tags') as never });
  };

  // Unfiltered lists: the header and switch counts, and the usage bar's 100%.
  // With an empty search the filtered query below shares this cache entry.
  const allTags = useTags();
  const groupsQuery = useGroups();
  const [dialog, setDialog] = useState<{ kind: 'new' } | { kind: 'edit'; group: TaxonomyGroup } | null>(null);

  const tagTotal = allTags.data?.length;
  const groupTotal = groupsQuery.data?.length;
  const meta = tagTotal !== undefined && groupTotal !== undefined ? `${pluralize(tagTotal, 'tag', 'tags')} · ${pluralize(groupTotal, 'group', 'groups')}` : undefined;

  return (
    <main className="TaxonomyAdmin" aria-labelledby="tag-group-admin-title">
      <AdminPageHeader
        titleId="tag-group-admin-title"
        title="Tags & groups"
        description="See how tags are used across items and manage the groups items can be filed in."
        meta={meta}
        primaryAction={
          view === 'groups' ? (
            <button type="button" className="kp-admin-button kp-admin-button--primary" onClick={() => setDialog({ kind: 'new' })}>
              <Icon icon={appIcons.plus} /> New group
            </button>
          ) : undefined
        }
      />

      <ViewSwitch<TagGroupView>
        label="Tags and groups views"
        idBase={VIEW_ID}
        value={view}
        onChange={setView}
        options={[
          { value: 'tags', label: 'Tags', count: tagTotal },
          { value: 'groups', label: 'Groups', count: groupTotal },
        ]}
      />

      <section className="TaxonomyAdmin__panel" role="tabpanel" id={viewPanelId(VIEW_ID)} aria-labelledby={viewTabId(VIEW_ID, view)}>
        {view === 'tags' ? (
          <TagsView allTags={allTags.data} />
        ) : (
          <GroupsView
            groups={groupsQuery.data}
            state={groupsQuery.isError ? 'error' : groupsQuery.isLoading ? 'loading' : 'ready'}
            errorMessage={errorText(groupsQuery.error, "Couldn't load groups.")}
            onRetry={() => void groupsQuery.refetch()}
            onNew={() => setDialog({ kind: 'new' })}
            onEdit={(group) => setDialog({ kind: 'edit', group })}
          />
        )}
      </section>

      {dialog ? (
        <GroupDialog
          // A different group is a different form: never carry a draft across.
          key={dialog.kind === 'edit' ? dialog.group.id : 'new'}
          group={dialog.kind === 'edit' ? dialog.group : undefined}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------- Tags

function TagsView({ allTags }: { allTags: TaxonomyTag[] | undefined }): JSX.Element {
  const [qInput, setQInput] = useState('');
  const q = useDebouncedValue(qInput.trim(), SEARCH_DEBOUNCE_MS);
  const [sort, setSort] = useState<TagSort>('usage');
  const [singleUseOnly, setSingleUseOnly] = useState(false);
  const tagsQuery = useTags(q, { keepPrevious: true });

  const rows = useMemo(() => arrangeTags(tagsQuery.data ?? [], { sort, singleUseOnly }), [tagsQuery.data, sort, singleUseOnly]);
  // Scale against every tag, not just the matches, so a bar means the same length whatever is typed.
  const max = maxCount(allTags ?? tagsQuery.data ?? []);
  const filtered = Boolean(q) || singleUseOnly;

  const columns: DataTableColumn<TaxonomyTag>[] = [
    {
      id: 'tag',
      header: 'Tag',
      primary: true,
      cell: (tag) => (
        <span className="TaxonomyAdmin__nameCell">
          <strong>{tag.name}</strong>
          {slugDiffersFromName(tag) ? <span className="TaxonomyAdmin__muted">{tag.slug}</span> : null}
        </span>
      ),
    },
    {
      id: 'items',
      header: 'Items',
      cell: (tag) => (
        <span className="TaxonomyAdmin__usage">
          <Link to="/search" search={{ tag: tag.name } as never} className="TaxonomyAdmin__itemsLink">
            {itemsLabel(tag.count)}
          </Link>
          <span className="TaxonomyAdmin__bar" aria-hidden="true">
            <span className="TaxonomyAdmin__barFill" style={{ width: `${usagePercent(tag.count, max)}%` }} />
          </span>
        </span>
      ),
    },
  ];

  return (
    <div className="TaxonomyAdmin__view">
      <div className="TaxonomyAdmin__toolbar" role="search" aria-label="Filter tags">
        <input
          className="TaxonomyAdmin__search"
          type="search"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Search tags…"
          aria-label="Search tags"
        />
        <label className="TaxonomyAdmin__sort">
          <span>Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as TagSort)}>
            <option value="usage">Most used</option>
            <option value="name">Name</option>
          </select>
        </label>
        <button type="button" className="TaxonomyAdmin__chip" aria-pressed={singleUseOnly} onClick={() => setSingleUseOnly((v) => !v)}>
          Used by only 1 item
        </button>
      </div>
      <p className="TaxonomyAdmin__note">Renaming and merging tags isn’t available yet.</p>
      <DataTable
        // Any change to what is listed starts again at the first page.
        key={`${q}|${sort}|${singleUseOnly}`}
        rows={rows}
        rowKey={(tag) => tag.id}
        rowLabel={(tag) => tag.name}
        columns={columns}
        caption="Tags"
        state={tagsQuery.isError ? 'error' : tagsQuery.isLoading || tagsQuery.isPlaceholderData ? 'loading' : 'ready'}
        errorMessage={errorText(tagsQuery.error, "Couldn't load tags.")}
        onRetry={() => void tagsQuery.refetch()}
        pageSize={TAGS_PAGE_SIZE}
        empty={
          filtered ? (
            <EmptyState title="No tags match" body="Try a different search, or turn off “Used by only 1 item”." />
          ) : (
            <EmptyState title="No tags yet" body="Tags appear here once items carry them in their frontmatter." />
          )
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------- Groups

interface GroupsViewProps {
  groups: TaxonomyGroup[] | undefined;
  state: 'loading' | 'error' | 'ready';
  errorMessage: string;
  onRetry: () => void;
  onNew: () => void;
  onEdit: (group: TaxonomyGroup) => void;
}

function GroupsView({ groups, state, errorMessage, onRetry, onNew, onEdit }: GroupsViewProps): JSX.Element {
  const { data: topics = [] } = useTopics();
  const archiveGroup = useArchiveGroup();
  const { push } = useToast();
  const [archiving, setArchiving] = useState<TaxonomyGroup | null>(null);

  const topicNames = useMemo(() => new Map(topics.map((t) => [t.id, t.name])), [topics]);
  const rows = useMemo(() => sortByName(groups ?? []), [groups]);

  const navigate = useNavigate();

  const rowActions = (group: TaxonomyGroup): OverflowMenuItem[] => [
    { id: 'edit', label: 'Edit…', onSelect: () => onEdit(group) },
    {
      id: 'items',
      label: 'View items',
      onSelect: () => void navigate({ to: '/search', search: { group: group.slug } as never }),
    },
    {
      id: 'archive',
      label: 'Archive…',
      danger: true,
      separatorBefore: true,
      onSelect: () => {
        archiveGroup.reset();
        setArchiving(group);
      },
      disabledReason: group.count > 0 ? `In use by ${itemsLabel(group.count)}` : undefined,
    },
  ];

  const columns: DataTableColumn<TaxonomyGroup>[] = [
    {
      id: 'group',
      header: 'Group',
      primary: true,
      cell: (group) => (
        <span className="TaxonomyAdmin__nameCell">
          <strong>{group.name}</strong>
          {group.description ? <span className="TaxonomyAdmin__muted">{group.description}</span> : null}
        </span>
      ),
    },
    { id: 'available', header: 'Available in', cell: (group) => availableInLabel(group, topicNames) },
    {
      id: 'items',
      header: 'Items',
      cell: (group) => (
        <Link to="/search" search={{ group: group.slug } as never} className="TaxonomyAdmin__itemsLink">
          {itemsLabel(group.count)}
        </Link>
      ),
    },
  ];

  const confirmArchive = async () => {
    if (!archiving) return;
    try {
      const archived = await archiveGroup.mutateAsync(archiving.id);
      setArchiving(null);
      push({ kind: 'success', message: `Archived group “${archived.name}”` });
    } catch {
      // Shown inside the confirm dialog.
    }
  };

  return (
    <div className="TaxonomyAdmin__view">
      <DataTable
        rows={rows}
        rowKey={(group) => group.id}
        rowLabel={(group) => group.name}
        columns={columns}
        caption="Groups"
        state={state}
        errorMessage={errorMessage}
        onRetry={onRetry}
        onRowOpen={onEdit}
        rowActions={rowActions}
        empty={
          <EmptyState
            title="No groups yet"
            body="Groups collect related items across or within topics."
            action={
              <button type="button" className="kp-admin-button kp-admin-button--primary" onClick={onNew}>
                <Icon icon={appIcons.plus} /> New group
              </button>
            }
          />
        }
      />
      {archiving ? (
        <ConfirmDialog
          title={`Archive “${archiving.name}”?`}
          body="The group leaves this list and is no longer offered for new items."
          consequences={['No items are in it, so nothing else changes.']}
          confirmLabel="Archive group"
          tone="danger"
          pending={archiveGroup.isPending}
          error={archiveGroup.isError ? errorText(archiveGroup.error, 'Could not archive the group.') : null}
          onConfirm={() => void confirmArchive()}
          onCancel={() => setArchiving(null)}
        />
      ) : null}
    </div>
  );
}
