/**
 * New primary category / Rename (the admin UX review §4.6): Name
 * and, on create only, Slug — an EditDialog (§3.3).
 *
 * The slug is what item frontmatter stores (`categories: [slug]`), so a rename
 * changes only the label; the helper says so rather than a paragraph above the
 * form. "Add to catalog" for a term items already carry is create with the
 * slug fixed to that term, so the catalog row matches what the items say.
 */
import { useState } from 'react';
import { EditDialog } from '../../components/admin/EditDialog.js';
import { FormField } from '../../components/admin/FormField.js';
import { useCreatePrimaryCategory, useUpdatePrimaryCategory, type TaxonomyCategory } from '../../queries.js';
import { useToast } from '../../hooks/useToast.js';
import { TAXONOMY_SLUG_MAX, effectiveSlug, errorText } from './taxonomyAdminModel.js';

export type CategoryDialogMode =
  | { kind: 'create' }
  /** A term items carry that has no catalog row: create it with this slug. */
  | { kind: 'curate'; category: TaxonomyCategory }
  | { kind: 'rename'; category: TaxonomyCategory };

export interface CategoryDialogProps {
  mode: CategoryDialogMode;
  onClose: () => void;
}

export function CategoryDialog({ mode, onClose }: CategoryDialogProps): JSX.Element {
  const initialName = mode.kind === 'create' ? '' : mode.category.name.trim() || mode.category.slug;
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState(mode.kind === 'curate' ? mode.category.slug : '');
  const createCategory = useCreatePrimaryCategory();
  const updateCategory = useUpdatePrimaryCategory();
  const { push } = useToast();
  const mutation = mode.kind === 'rename' ? updateCategory : createCategory;

  const dirty = name !== initialName || (mode.kind === 'create' && slug !== '');
  // A curate dialog can save untouched: its whole point is the prefilled term.
  const canSave = (dirty || mode.kind === 'curate') && name.trim().length > 0;
  const derived = effectiveSlug(name, slug);

  const submit = async () => {
    try {
      if (mode.kind === 'rename') {
        const saved = await updateCategory.mutateAsync({ slug: mode.category.slug, name: name.trim() });
        push({ kind: 'success', message: `Renamed to “${saved.name}”` });
      } else {
        const created = await createCategory.mutateAsync({ name: name.trim(), slug: slug.trim() || undefined });
        push({ kind: 'success', message: `Created primary category “${created.name}”` });
      }
      onClose();
    } catch {
      // The mutation's error renders inside the dialog, next to Save.
    }
  };

  const title = mode.kind === 'rename' ? 'Rename primary category' : mode.kind === 'curate' ? 'Add to catalog' : 'New primary category';
  const submitLabel = mode.kind === 'rename' ? 'Save' : mode.kind === 'curate' ? 'Add to catalog' : 'Create category';

  return (
    <EditDialog
      open
      title={title}
      description={mode.kind === 'create' ? undefined : `Slug: ${mode.category.slug}`}
      isDirty={dirty}
      isSaving={mutation.isPending}
      canSave={canSave}
      submitLabel={submitLabel}
      error={mutation.isError ? errorText(mutation.error, 'Could not save the category.') : null}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <FormField
        label="Name"
        htmlFor="category-name"
        required
        helper={mode.kind === 'rename' ? 'Items keep their category; only the label changes.' : undefined}
      >
        {(control) => (
          <input
            {...control}
            value={name}
            onChange={(e) => {
              mutation.reset();
              setName(e.target.value);
            }}
            maxLength={200}
            autoComplete="off"
          />
        )}
      </FormField>
      {mode.kind === 'create' ? (
        <FormField
          label="Slug"
          htmlFor="category-slug"
          helper={derived ? `Items file under the slug: ${derived}. It can’t be changed later.` : 'Leave blank to derive it from the name. It can’t be changed later.'}
        >
          {(control) => (
            <input
              {...control}
              value={slug}
              onChange={(e) => {
                mutation.reset();
                setSlug(e.target.value);
              }}
              maxLength={TAXONOMY_SLUG_MAX}
              placeholder={effectiveSlug(name, '') || 'derived from the name'}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </FormField>
      ) : null}
    </EditDialog>
  );
}
