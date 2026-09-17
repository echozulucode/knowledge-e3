/**
 * PrimaryCategoryAdmin — `/admin/primary-categories` (the admin UX review §4.6).
 *
 * The curated category catalog as one DataTable: Name (slug muted) · Items
 * (a link to the search they file) · `⋯` (Rename…, View items, Archive…). The
 * old page padded the table with an always-empty Metadata column, a hardcoded
 * "Active" chip and a Refresh button; the API has no colour or icon yet, and
 * the list refetches itself, so they are gone.
 *
 * Archive is a confirm plus a toast with Undo (the server has restore), and is
 * disabled with "In use by N items" as text while items are filed under the
 * term. The API still allows that (retiring a term drafts use is how publishes
 * into it are stopped); the page keeps to the case where Undo is a clean round
 * trip. `Active | Archived` (`?view=archived`) lists retired terms with Restore.
 *
 * The active list is "what exists" (`usePrimaryCategories`: the catalog plus
 * terms items carry). A term with no catalog row is marked "Not in catalog"
 * and offers "Add to catalog…" instead of a Rename that would 404; one whose
 * row is archived is marked "Archived" and offers Restore.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Icon, appIcons } from '../icons.js';
import { AdminPageHeader } from '../components/admin/AdminPageHeader.js';
import { ConfirmDialog } from '../components/admin/ConfirmDialog.js';
import { DataTable, type DataTableColumn } from '../components/admin/DataTable.js';
import { EmptyState } from '../components/admin/EmptyState.js';
import type { OverflowMenuItem } from '../components/admin/OverflowMenu.js';
import { StatusChip } from '../components/admin/StatusChip.js';
import { useToast } from '../hooks/useToast.js';
import { useCuratedCategories } from '../features/compose/queries.js';
import {
  useArchivePrimaryCategory,
  useArchivedPrimaryCategories,
  usePrimaryCategories,
  useRestorePrimaryCategory,
  type TaxonomyCategory,
} from '../queries.js';
import { CategoryDialog, type CategoryDialogMode } from '../features/taxonomy-admin/CategoryDialog.js';
import { ViewSwitch, viewPanelId, viewTabId } from '../features/taxonomy-admin/ViewSwitch.js';
import {
  CATEGORY_SEARCH_THRESHOLD,
  categoryActionRules,
  errorText,
  filterByText,
  itemsLabel,
  pluralize,
  readCategoryView,
  sortByName,
  viewSearch,
  type CategoryView,
} from '../features/taxonomy-admin/taxonomyAdminModel.js';
import '../features/taxonomy-admin/TaxonomyAdmin.css';
import './PrimaryCategoryAdmin.css';

const VIEW_ID = 'primary-category-view';

function displayName(category: TaxonomyCategory): string {
  return category.name.trim() || category.slug;
}

export function PrimaryCategoryAdmin() {
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown> | undefined;
  const view = readCategoryView(rawSearch);
  const setView = (next: CategoryView) => {
    void navigate({ to: '/admin/primary-categories', search: viewSearch(next, 'active') as never });
  };

  const categoriesQuery = usePrimaryCategories();
  const curatedQuery = useCuratedCategories();
  const archivedQuery = useArchivedPrimaryCategories();
  const archiveCategory = useArchivePrimaryCategory();
  const restoreCategory = useRestorePrimaryCategory();
  const { push } = useToast();

  const [dialog, setDialog] = useState<CategoryDialogMode | null>(null);
  const [archiving, setArchiving] = useState<TaxonomyCategory | null>(null);
  const [query, setQuery] = useState('');

  const curatedSlugs = useMemo(() => new Set((curatedQuery.data ?? []).map((c) => c.slug)), [curatedQuery.data]);
  // Until the curated list arrives, treat every row as curated rather than
  // flashing "Not in catalog" on all of them.
  const isCurated = (category: TaxonomyCategory) => !curatedQuery.data || curatedSlugs.has(category.slug);

  const active = useMemo(() => sortByName(categoriesQuery.data ?? []), [categoriesQuery.data]);
  const archived = useMemo(() => archivedQuery.data ?? [], [archivedQuery.data]);
  // An archived term items still carry stays on the Active list (it is "what
  // exists"). It needs Restore, not Add to catalog — its slug is taken.
  const archivedSlugs = useMemo(() => new Set(archived.map((c) => c.slug)), [archived]);
  const isArchivedTerm = (category: TaxonomyCategory) => !isCurated(category) && archivedSlugs.has(category.slug);
  const source = view === 'archived' ? archived : active;
  const showSearch = source.length > CATEGORY_SEARCH_THRESHOLD;
  const rows = useMemo(() => (showSearch ? filterByText(source, query) : source), [showSearch, source, query]);
  const uncurated = curatedQuery.data ? active.filter((c) => !curatedSlugs.has(c.slug)).length : 0;

  const meta = categoriesQuery.data
    ? `${pluralize(active.length, 'category', 'categories')}${uncurated > 0 ? ` · ${uncurated.toLocaleString('en-US')} not in catalog` : ''}`
    : undefined;

  const restore = async (category: TaxonomyCategory) => {
    try {
      const restored = await restoreCategory.mutateAsync(category.slug);
      push({ kind: 'success', message: `Restored “${displayName(restored)}”` });
    } catch (error) {
      push({ kind: 'error', message: errorText(error, `Could not restore “${displayName(category)}”.`) });
    }
  };

  const confirmArchive = async () => {
    if (!archiving) return;
    try {
      const done = await archiveCategory.mutateAsync(archiving.slug);
      setArchiving(null);
      push({ kind: 'success', message: `Archived “${displayName(done)}”`, action: { label: 'Undo', onAction: () => void restore(done) } });
    } catch {
      // Shown inside the confirm dialog.
    }
  };

  const viewItems = (category: TaxonomyCategory) => void navigate({ to: '/search', search: { category: category.slug } as never });

  const activeActions = (category: TaxonomyCategory): OverflowMenuItem[] => {
    const curated = isCurated(category);
    const rules = categoryActionRules(category, curated);
    return [
      curated
        ? { id: 'rename', label: 'Rename…', onSelect: () => setDialog({ kind: 'rename', category }) }
        : isArchivedTerm(category)
          ? { id: 'restore', label: 'Restore', onSelect: () => void restore(category) }
          : { id: 'curate', label: 'Add to catalog…', onSelect: () => setDialog({ kind: 'curate', category }) },
      { id: 'items', label: 'View items', onSelect: () => viewItems(category) },
      {
        id: 'archive',
        label: 'Archive…',
        danger: true,
        separatorBefore: true,
        disabledReason: isArchivedTerm(category) ? 'Already archived' : rules.archiveReason,
        onSelect: () => {
          archiveCategory.reset();
          setArchiving(category);
        },
      },
    ];
  };

  const archivedActions = (category: TaxonomyCategory): OverflowMenuItem[] => [
    {
      id: 'restore',
      label: 'Restore',
      onSelect: () => void restore(category),
      disabledReason: restoreCategory.isPending && restoreCategory.variables === category.slug ? 'Restoring…' : undefined,
    },
    { id: 'items', label: 'View items', onSelect: () => viewItems(category) },
  ];

  const nameColumn: DataTableColumn<TaxonomyCategory> = {
    id: 'name',
    header: 'Name',
    primary: true,
    cell: (category) => (
      <span className="TaxonomyAdmin__nameCell">
        <strong>{displayName(category)}</strong>
        <span className="PrimaryCategoryAdmin__slugLine">
          <code className="TaxonomyAdmin__muted">{category.slug}</code>
          {/* Only on the rare term items carry that nobody curated: a column for it would be empty on every other row. */}
          {view === 'active' && !isCurated(category) ? (
            isArchivedTerm(category) ? <StatusChip tone="info" label="Archived" size="sm" /> : <StatusChip tone="warn" label="Not in catalog" size="sm" />
          ) : null}
        </span>
      </span>
    ),
  };
  const itemsColumn: DataTableColumn<TaxonomyCategory> = {
    id: 'items',
    header: 'Items',
    cell: (category) => (
      <Link to="/search" search={{ category: category.slug } as never} className="TaxonomyAdmin__itemsLink">
        {itemsLabel(category.count)}
      </Link>
    ),
  };
  const columns: DataTableColumn<TaxonomyCategory>[] =
    view === 'archived'
      ? [
          nameColumn,
          itemsColumn,
          {
            id: 'archived',
            header: 'Archived',
            hideBelow: 'md',
            cell: (category) =>
              category.archived_at ? (
                <time className="PrimaryCategoryAdmin__date" dateTime={category.archived_at} title={new Date(category.archived_at).toLocaleString()}>
                  {new Date(category.archived_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                </time>
              ) : null,
          },
        ]
      : [nameColumn, itemsColumn];

  const listQuery = view === 'archived' ? archivedQuery : categoriesQuery;
  const hasQuery = showSearch && query.trim().length > 0;

  return (
    <main className="TaxonomyAdmin" aria-labelledby="primary-category-admin-title">
      <AdminPageHeader
        titleId="primary-category-admin-title"
        title="Primary categories"
        description="The curated categories an item can be published under."
        meta={meta}
        primaryAction={
          <button type="button" className="kp-admin-button kp-admin-button--primary" onClick={() => setDialog({ kind: 'create' })}>
            <Icon icon={appIcons.plus} /> New primary category
          </button>
        }
      />

      <ViewSwitch<CategoryView>
        label="Primary category views"
        idBase={VIEW_ID}
        value={view}
        onChange={(next) => {
          setQuery('');
          setView(next);
        }}
        options={[
          { value: 'active', label: 'Active', count: categoriesQuery.data ? active.length : undefined },
          { value: 'archived', label: 'Archived', count: archivedQuery.data?.length },
        ]}
      />

      <section className="TaxonomyAdmin__panel" role="tabpanel" id={viewPanelId(VIEW_ID)} aria-labelledby={viewTabId(VIEW_ID, view)}>
        {showSearch ? (
          <div className="TaxonomyAdmin__toolbar" role="search" aria-label="Filter primary categories">
            <input
              className="TaxonomyAdmin__search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search categories…"
              aria-label="Search primary categories"
            />
          </div>
        ) : null}
        <DataTable
          key={view}
          rows={rows}
          rowKey={(category) => category.slug}
          rowLabel={displayName}
          columns={columns}
          caption={view === 'archived' ? 'Archived primary categories' : 'Primary categories'}
          state={listQuery.isError ? 'error' : listQuery.isLoading ? 'loading' : 'ready'}
          errorMessage={errorText(listQuery.error, "Couldn't load primary categories.")}
          onRetry={() => void listQuery.refetch()}
          onRowOpen={
            view === 'archived'
              ? undefined
              : (category) => {
                  if (isArchivedTerm(category)) return;
                  setDialog(isCurated(category) ? { kind: 'rename', category } : { kind: 'curate', category });
                }
          }
          rowActions={view === 'archived' ? archivedActions : activeActions}
          empty={
            hasQuery ? (
              <EmptyState title="No categories match" body={`Nothing is named or filed under “${query.trim()}”.`} />
            ) : view === 'archived' ? (
              <EmptyState title="Nothing archived" body="Archived categories appear here, ready to restore." />
            ) : (
              <EmptyState
                title="No primary categories yet"
                body="Items are published under exactly one primary category from this catalog."
                action={
                  <button type="button" className="kp-admin-button kp-admin-button--primary" onClick={() => setDialog({ kind: 'create' })}>
                    <Icon icon={appIcons.plus} /> New primary category
                  </button>
                }
              />
            )
          }
        />
      </section>

      {dialog ? (
        <CategoryDialog key={dialog.kind === 'create' ? 'create' : `${dialog.kind}:${dialog.category.slug}`} mode={dialog} onClose={() => setDialog(null)} />
      ) : null}

      {archiving ? (
        <ConfirmDialog
          title={`Archive “${displayName(archiving)}”?`}
          body="It leaves the catalog and can no longer be chosen when publishing."
          consequences={['No items are filed under it, so nothing else changes.', 'You can restore it from Archived.']}
          confirmLabel="Archive category"
          tone="danger"
          pending={archiveCategory.isPending}
          error={archiveCategory.isError ? errorText(archiveCategory.error, 'Could not archive the category.') : null}
          onConfirm={() => void confirmArchive()}
          onCancel={() => setArchiving(null)}
        />
      ) : null}
    </main>
  );
}
