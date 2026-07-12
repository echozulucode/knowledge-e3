import { FormEvent, useMemo, useState } from 'react';
import {
  useArchivePrimaryCategory,
  useCreatePrimaryCategory,
  usePrimaryCategories,
  useUpdatePrimaryCategory,
  type TaxonomyCategory,
} from '../queries.js';
import { Icon, appIcons } from '../icons.js';
import { AdminTabs } from '../components/admin/AdminTabs.js';
import './PrimaryCategoryAdmin.css';

function pluralizeItem(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

function categoryDisplayName(category: TaxonomyCategory): string {
  return category.name.trim() || category.slug;
}

function metadataLabel(category: TaxonomyCategory): string {
  const metadata = [category.color ? `Color ${category.color}` : null, category.icon ? `Icon ${category.icon}` : null].filter(Boolean);
  return metadata.length ? metadata.join(' · ') : 'No color/icon metadata yet';
}

function errorToMessage(error: unknown, fallback: string): string {
  return error && typeof error === 'object' && 'message' in error
    ? String((error as { message?: unknown }).message)
    : fallback;
}

export function PrimaryCategoryAdmin() {
  const { data: categories = [], isLoading, isError, error, refetch } = usePrimaryCategories();
  const createCategory = useCreatePrimaryCategory();
  const updateCategory = useUpdatePrimaryCategory();
  const archiveCategory = useArchivePrimaryCategory();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<TaxonomyCategory | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => categoryDisplayName(a).localeCompare(categoryDisplayName(b), undefined, { sensitivity: 'base' })),
    [categories],
  );
  const totalAssignments = sortedCategories.reduce((sum, category) => sum + category.count, 0);
  const errorMessage = errorToMessage(error, 'Unable to load primary categories.');
  const mutationError = errorToMessage(createCategory.error ?? updateCategory.error ?? archiveCategory.error, 'Unable to save primary category.');
  const canCreate = name.trim().length > 0 && !createCategory.isPending;
  const canSaveEdit = name.trim().length > 0 && !updateCategory.isPending;

  function closeCreate() {
    if (createCategory.isPending) return;
    setIsCreateOpen(false);
    setName('');
    setSlug('');
  }

  function openRename(category: TaxonomyCategory) {
    setEditingCategory(category);
    setName(categoryDisplayName(category));
    setMessage(null);
  }

  function closeRename() {
    if (updateCategory.isPending) return;
    setEditingCategory(null);
    setName('');
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) return;

    try {
      const category = await createCategory.mutateAsync({
        name: name.trim(),
        slug: slug.trim() || undefined,
      });
      closeCreate();
      setMessage(`Primary category created: ${category.name}`);
    } catch {
      // TanStack Query exposes the error through createCategory.error for inline rendering.
    }
  }

  async function handleRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingCategory || !canSaveEdit) return;
    try {
      const category = await updateCategory.mutateAsync({ slug: editingCategory.slug, name: name.trim() });
      closeRename();
      setMessage(`Primary category saved: ${category.name}`);
    } catch {
      // Inline mutation error is rendered below the dialog.
    }
  }

  async function handleArchive(category: TaxonomyCategory) {
    try {
      await archiveCategory.mutateAsync(category.slug);
      setMessage(`Category archived: ${categoryDisplayName(category)}`);
    } catch {
      // Inline mutation error is rendered below actions.
    }
  }

  return (
    <main className="PrimaryCategoryAdmin" aria-labelledby="primary-category-admin-title">
      <AdminTabs />
      <section className="PrimaryCategoryAdmin__hero">
        <div className="PrimaryCategoryAdmin__eyebrow">
          <Icon icon={appIcons.layerGroup} />
          <span>Admin catalog</span>
        </div>
        <div className="PrimaryCategoryAdmin__heroGrid">
          <div>
            <h1 id="primary-category-admin-title">Primary categories</h1>
            <p>
              Curate the primary category catalog separately from article editing. Existing articles keep their derived
              category metadata; this screen is the safe admin surface for catalog review.
            </p>
          </div>
          <div className="PrimaryCategoryAdmin__stats" aria-label="Primary category summary">
            <strong>{sortedCategories.length}</strong>
            <span>categories</span>
            <strong>{totalAssignments}</strong>
            <span>item assignments</span>
          </div>
        </div>
      </section>

      <section className="PrimaryCategoryAdmin__panel" aria-live="polite">
        <div className="PrimaryCategoryAdmin__sectionHeader">
          <div>
            <h2>Existing primary categories</h2>
            <p>Catalog entries plus derived usage counts from existing item category assignments.</p>
          </div>
          <button type="button" className="PrimaryCategoryAdmin__refresh" onClick={() => void refetch()}>
            Refresh
          </button>
        </div>

        {isLoading ? (
          <div className="PrimaryCategoryAdmin__state" role="status">
            <span className="PrimaryCategoryAdmin__spinner" aria-hidden="true" />
            Loading primary categories…
          </div>
        ) : isError ? (
          <div className="PrimaryCategoryAdmin__state PrimaryCategoryAdmin__state--error" role="alert">
            <strong>Category catalog unavailable</strong>
            <span>{errorMessage}</span>
            <button type="button" onClick={() => void refetch()}>Try again</button>
          </div>
        ) : sortedCategories.length === 0 ? (
          <div className="PrimaryCategoryAdmin__state">
            <strong>No primary categories yet</strong>
            <span>Create the first primary category from the action panel below, or import items with category frontmatter.</span>
          </div>
        ) : (
          <table className="PrimaryCategoryAdmin__table" aria-label="Primary category catalog">
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Slug</th>
                <th scope="col">Usage</th>
                <th scope="col">Metadata</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedCategories.map((category) => (
                <tr key={category.slug}>
                  <td>{categoryDisplayName(category)}</td>
                  <td><code>{category.slug}</code></td>
                  <td>{pluralizeItem(category.count)}</td>
                  <td>{metadataLabel(category)}</td>
                  <td><span className="PrimaryCategoryAdmin__badge">Active</span></td>
                  <td>
                    <div className="PrimaryCategoryAdmin__rowActions">
                      <button type="button" onClick={() => openRename(category)} aria-label={`Rename category ${categoryDisplayName(category)}`}>
                        <Icon icon={appIcons.pencil} /> Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleArchive(category)}
                        disabled={category.count > 0 || archiveCategory.isPending}
                        aria-label={`Archive category ${categoryDisplayName(category)}`}
                        title={category.count > 0 ? 'Categories with assigned items cannot be archived.' : 'Archive category'}
                      >
                        <Icon icon={appIcons.xmark} /> Archive
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="PrimaryCategoryAdmin__panel" aria-label="Primary category actions">
        <div>
          <h2>Catalog actions</h2>
          <p>
            Create and rename primary category catalog entries for future items. Color and icon metadata is shown when
            the backend provides it; merge and reassignment workflows stay out of the editor.
          </p>
        </div>
        <div className="PrimaryCategoryAdmin__actions">
          <button type="button" onClick={() => setIsCreateOpen(true)}>
            <Icon icon={appIcons.plus} />
            Create category
          </button>
        </div>
        <p id="primary-category-admin-defer-note" className="PrimaryCategoryAdmin__deferNote">
          Categories with assigned items cannot be archived. Article category reassignment stays out of the current MVP path.
        </p>
        {message ? <p className="PrimaryCategoryAdmin__success" role="status">{message}</p> : null}
        {(createCategory.isError || updateCategory.isError || archiveCategory.isError) ? (
          <p className="PrimaryCategoryAdmin__error" role="alert">{mutationError}</p>
        ) : null}
      </section>

      {isCreateOpen ? (
        <div className="PrimaryCategoryAdmin__modalBackdrop">
          <section className="PrimaryCategoryAdmin__modal" role="dialog" aria-modal="true" aria-labelledby="primary-category-create-title">
            <div className="PrimaryCategoryAdmin__modalHeader">
              <div>
                <h2 id="primary-category-create-title">New primary category</h2>
                <p>Create a catalog entry using the backend-supported primary category fields.</p>
              </div>
              <button type="button" className="PrimaryCategoryAdmin__iconButton" onClick={closeCreate} aria-label="Close new primary category dialog">
                <Icon icon={appIcons.xmark} />
              </button>
            </div>
            <form className="PrimaryCategoryAdmin__form" onSubmit={(event) => void handleCreate(event)}>
              <label>
                <span>Category name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required />
              </label>
              <label>
                <span>Category slug</span>
                <input value={slug} onChange={(event) => setSlug(event.target.value)} maxLength={100} placeholder="auto-generated if blank" />
              </label>
              <div className="PrimaryCategoryAdmin__modalActions">
                <button type="button" onClick={closeCreate} disabled={createCategory.isPending}>Cancel</button>
                <button type="submit" disabled={!canCreate}>
                  <Icon icon={appIcons.plus} />
                  {createCategory.isPending ? 'Creating…' : 'Create category'}
                </button>
              </div>
            </form>
            {createCategory.isError ? <p className="PrimaryCategoryAdmin__error" role="alert">{mutationError}</p> : null}
          </section>
        </div>
      ) : null}

      {editingCategory ? (
        <div className="PrimaryCategoryAdmin__modalBackdrop">
          <section className="PrimaryCategoryAdmin__modal" role="dialog" aria-modal="true" aria-labelledby="primary-category-rename-title">
            <div className="PrimaryCategoryAdmin__modalHeader">
              <div>
                <h2 id="primary-category-rename-title">Rename primary category</h2>
                <p>Update the display name. Slugs and existing item assignments stay unchanged.</p>
              </div>
              <button type="button" className="PrimaryCategoryAdmin__iconButton" onClick={closeRename} aria-label="Close rename primary category dialog">
                <Icon icon={appIcons.xmark} />
              </button>
            </div>
            <form className="PrimaryCategoryAdmin__form" onSubmit={(event) => void handleRename(event)}>
              <label>
                <span>Category name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required />
              </label>
              <div className="PrimaryCategoryAdmin__modalActions">
                <button type="button" onClick={closeRename} disabled={updateCategory.isPending}>Cancel</button>
                <button type="submit" disabled={!canSaveEdit}>{updateCategory.isPending ? 'Saving…' : 'Save category'}</button>
              </div>
            </form>
            {updateCategory.isError ? <p className="PrimaryCategoryAdmin__error" role="alert">{mutationError}</p> : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}
