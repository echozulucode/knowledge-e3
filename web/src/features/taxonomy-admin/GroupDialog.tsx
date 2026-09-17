/**
 * New group / Edit group (the admin UX review §4.6) — four fields,
 * so an EditDialog (§3.3). One "Available in" picker over topics, with "All
 * topics" as its empty choice, replaces the old Scope select plus a second
 * Topic select that only appeared for one of Scope's two values.
 *
 * The slug is create-only: items reference a group by id and frontmatter
 * names it by slug, so neither may change afterwards. Blank means "derive it
 * from the name", and the helper shows exactly what the server will store.
 */
import { useState } from 'react';
import { EditDialog } from '../../components/admin/EditDialog.js';
import { FormField } from '../../components/admin/FormField.js';
import { ReferencePicker } from '../../components/admin/ReferencePicker.js';
import { useCreateGroup, useTopics, useUpdateGroup, type TaxonomyGroup, type Topic } from '../../queries.js';
import { useToast } from '../../hooks/useToast.js';
import {
  TAXONOMY_SLUG_MAX,
  effectiveSlug,
  errorText,
  groupCreateBody,
  groupDraftDirty,
  groupDraftFrom,
  groupUpdateBody,
  type GroupDraft,
} from './taxonomyAdminModel.js';

export interface GroupDialogProps {
  /** The group to edit; omitted for New group. */
  group?: TaxonomyGroup;
  onClose: () => void;
}

export function GroupDialog({ group, onClose }: GroupDialogProps): JSX.Element {
  const editing = Boolean(group);
  const [initial] = useState<GroupDraft>(() => groupDraftFrom(group));
  const [draft, setDraft] = useState<GroupDraft>(initial);
  const { data: topics = [], isLoading: topicsLoading } = useTopics();
  const createGroup = useCreateGroup();
  const updateGroup = useUpdateGroup();
  const { push } = useToast();
  const mutation = editing ? updateGroup : createGroup;

  const patch = (next: Partial<GroupDraft>) => {
    mutation.reset();
    setDraft((current) => ({ ...current, ...next }));
  };
  const derived = effectiveSlug(draft.name, draft.slug);
  const dirty = groupDraftDirty(draft, initial);

  const submit = async () => {
    try {
      if (group) {
        const saved = await updateGroup.mutateAsync({ id: group.id, ...groupUpdateBody(draft) });
        push({ kind: 'success', message: `Saved group “${saved.name}”` });
      } else {
        const created = await createGroup.mutateAsync(groupCreateBody(draft));
        push({ kind: 'success', message: `Created group “${created.name}”` });
      }
      onClose();
    } catch {
      // The mutation's error renders inside the dialog, next to Save.
    }
  };

  return (
    <EditDialog
      open
      title={editing ? 'Edit group' : 'New group'}
      description={editing ? `Slug: ${group?.slug}` : undefined}
      isDirty={dirty}
      isSaving={mutation.isPending}
      canSave={dirty && draft.name.trim().length > 0}
      submitLabel={editing ? 'Save group' : 'Create group'}
      error={mutation.isError ? errorText(mutation.error, editing ? 'Could not save the group.' : 'Could not create the group.') : null}
      onSubmit={() => void submit()}
      onClose={onClose}
      width="md"
    >
      <FormField label="Name" htmlFor="group-name" required>
        {(control) => <input {...control} value={draft.name} onChange={(e) => patch({ name: e.target.value })} maxLength={200} autoComplete="off" />}
      </FormField>
      {editing ? null : (
        <FormField
          label="Slug"
          htmlFor="group-slug"
          helper={derived ? `Items name the group by its slug: ${derived}. It can’t be changed later.` : 'Leave blank to derive it from the name. It can’t be changed later.'}
        >
          {(control) => (
            <input
              {...control}
              value={draft.slug}
              onChange={(e) => patch({ slug: e.target.value })}
              maxLength={TAXONOMY_SLUG_MAX}
              placeholder={effectiveSlug(draft.name, '') || 'derived from the name'}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </FormField>
      )}
      <FormField label="Available in" htmlFor="group-available-in" helper="Offer the group in every topic, or only in one.">
        {(control) => (
          <ReferencePicker<Topic>
            id={control.id}
            aria-describedby={control['aria-describedby']}
            options={topics}
            loading={topicsLoading}
            getKey={(t) => t.id}
            getLabel={(t) => t.name}
            emptyOption={{ label: 'All topics' }}
            value={draft.topicId}
            onChange={(topicId) => patch({ topicId })}
            invalidValueMessage={() => 'That topic no longer exists. Choose another, or All topics.'}
            placeholder="All topics"
            testId="group-available-in"
          />
        )}
      </FormField>
      <FormField label="Description" htmlFor="group-description">
        {(control) => <textarea {...control} value={draft.description} onChange={(e) => patch({ description: e.target.value })} maxLength={1000} rows={3} />}
      </FormField>
    </EditDialog>
  );
}
