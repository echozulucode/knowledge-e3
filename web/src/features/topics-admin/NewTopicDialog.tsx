/**
 * NewTopicDialog — `+ New topic` on `/admin/topics` (the admin UX review §4.5).
 *
 * A dialog, not a page: four questions (name, slug, description, visibility)
 * plus an optional repository binding tucked behind a disclosure, because most
 * topics live in the main repository and the binding is the one field whose
 * mistakes are expensive. Everything else about a topic — presentation, Start
 * here, landing text — is set on the edit page this dialog opens on success.
 *
 * Two rules carried over from P0 (`topicCreateModel.ts`):
 *   - the slug follows the name until the admin edits it, and shows exactly
 *     what the server will store (`slugifyTopic`);
 *   - a repository URL preselects Private, and says why, until the admin picks
 *     a visibility themselves — after which their choice stands.
 */
import { useId, useState } from 'react';
import { EditDialog } from '../../components/admin/EditDialog.js';
import { FormField } from '../../components/admin/FormField.js';
import { StatusChip } from '../../components/admin/StatusChip.js';
import { useCreateTopic, useTestRepoConnection, type Topic } from '../../queries.js';
import { createTopicBody, slugifyTopic, topicSlugProblem, visibilityForRepoUrl, type TopicVisibility } from '../../pages/topicCreateModel.js';
import { createdMessage } from './topicsAdminModel.js';

export interface NewTopicDialogProps {
  existing: readonly { slug: string }[];
  onClose: () => void;
  /** Called with the created topic and the toast message to show. */
  onCreated: (topic: Topic, message: string) => void;
}

function errorMessage(error: unknown): string {
  const message = error && typeof error === 'object' && 'message' in error ? String((error as { message?: unknown }).message ?? '') : '';
  if (/slug already exists/i.test(message)) return 'Another topic, possibly an archived one, already uses this slug. Choose a different slug.';
  return message || 'The topic could not be created.';
}

export function NewTopicDialog({ existing, onClose, onCreated }: NewTopicDialogProps): JSX.Element {
  const createTopic = useCreateTopic();
  const testConnection = useTestRepoConnection();
  const visibilityName = useId();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<TopicVisibility>('public');
  const [visibilityChosen, setVisibilityChosen] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [repoBranch, setRepoBranch] = useState('');
  const [repoPull, setRepoPull] = useState(true);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSlug = slugTouched ? slugifyTopic(slug) : slugifyTopic(name);
  const slugProblem = name.trim() || slug.trim() ? topicSlugProblem(effectiveSlug, existing) : null;
  const nameProblem = attempted && !name.trim() ? 'Enter a name.' : null;
  const hasRepo = repoUrl.trim() !== '';
  const isDirty = Boolean(name.trim() || slug.trim() || description.trim() || repoUrl.trim() || repoBranch.trim() || visibilityChosen);

  function changeName(next: string) {
    setName(next);
    setError(null);
    if (!slugTouched) setSlug(slugifyTopic(next));
  }

  function changeRepoUrl(next: string) {
    setRepoUrl(next);
    setVisibility((current) => visibilityForRepoUrl(next, current, visibilityChosen));
    // A result is about the URL it tested; a different URL has not been tested.
    if (testConnection.data || testConnection.error) testConnection.reset();
  }

  async function submit() {
    setAttempted(true);
    if (!name.trim() || slugProblem) return;
    setError(null);
    try {
      const topic = await createTopic.mutateAsync(
        createTopicBody({ name, slug: effectiveSlug, description, visibility, repoUrl, repoBranch, repoPull }),
      );
      onCreated(topic, createdMessage(topic.name, repoUrl, repoPull));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const testResult = testConnection.data;

  return (
    <EditDialog
      open
      title="New topic"
      description={<p>Set the landing page and its sections on the next page.</p>}
      width="md"
      isDirty={isDirty}
      isSaving={createTopic.isPending}
      canSave={name.trim() !== '' && !slugProblem}
      submitLabel="Create topic"
      error={error}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <FormField label="Name" htmlFor="new-topic-name" required error={nameProblem}>
        {(control) => (
          <input {...control} className="TopicForm__input" value={name} onChange={(e) => changeName(e.target.value)} maxLength={200} autoComplete="off" />
        )}
      </FormField>
      <FormField
        label="Slug"
        htmlFor="new-topic-slug"
        error={slugProblem}
        helper={
          <>
            The topic’s address, <code>/topics/{effectiveSlug || '…'}</code>. Made from the name; it cannot be changed after the topic is created.
          </>
        }
      >
        {(control) => (
          <input
            {...control}
            className="TopicForm__input TopicForm__mono"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
              setError(null);
            }}
            onBlur={() => {
              if (slugTouched) setSlug(slugifyTopic(slug));
            }}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </FormField>
      <FormField label="Description" htmlFor="new-topic-description" helper="One line, shown on the topic list and the landing page.">
        {(control) => (
          <textarea {...control} className="TopicForm__input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
        )}
      </FormField>

      <fieldset className="TopicForm__fieldset" aria-describedby={hasRepo ? 'new-topic-visibility-note new-topic-visibility-why' : 'new-topic-visibility-note'}>
        <legend className="TopicForm__legend">Visibility</legend>
        <div className="TopicForm__radios">
          {(['public', 'private'] as const).map((value) => (
            <label key={value} className="TopicForm__radio">
              <input
                type="radio"
                name={visibilityName}
                value={value}
                checked={visibility === value}
                onChange={() => {
                  setVisibility(value);
                  setVisibilityChosen(true);
                }}
              />
              <span>{value === 'public' ? 'Public' : 'Private'}</span>
            </label>
          ))}
        </div>
        {/* The schema comment's wording: this narrows PUBLIC exposure only, it is not an ACL. */}
        <p className="TopicForm__note" id="new-topic-visibility-note">
          Private hides this topic from anonymous visitors. Signed-in users are unaffected.
        </p>
        {hasRepo ? (
          <p className="TopicForm__note" id="new-topic-visibility-why">
            Private is suggested for a repository topic, so content pulled from it is not visible to anonymous visitors before
            someone has reviewed it.
          </p>
        ) : null}
      </fieldset>

      <details className="TopicForm__disclosure">
        <summary>Dedicated repository (advanced)</summary>
        <div className="TopicForm__disclosureBody">
          <FormField label="Repository URL" htmlFor="new-topic-repo-url" helper="Leave blank to keep the topic in the main repository.">
            {(control) => (
              <div className="TopicForm__row">
                <input
                  {...control}
                  className="TopicForm__input TopicForm__mono"
                  value={repoUrl}
                  onChange={(e) => changeRepoUrl(e.target.value)}
                  placeholder="git@host:org/topic.git"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="kp-admin-button"
                  disabled={!hasRepo || testConnection.isPending}
                  onClick={() => testConnection.mutate(repoUrl.trim())}
                >
                  {testConnection.isPending ? 'Testing…' : 'Test connection'}
                </button>
              </div>
            )}
          </FormField>
          {testResult || testConnection.error ? (
            <p className="TopicForm__testResult" role="status">
              {testResult?.ok ? (
                <StatusChip tone="ok" size="sm" label="Reachable" />
              ) : (
                <StatusChip tone="error" size="sm" label="Not reachable" />
              )}
              <span>{testResult?.message ?? (testConnection.error as { message?: string } | null)?.message ?? ''}</span>
            </p>
          ) : null}
          {hasRepo ? (
            <>
              <FormField label="Branch" htmlFor="new-topic-repo-branch" helper="Leave blank for the repository’s current branch.">
                {(control) => (
                  <input {...control} className="TopicForm__input TopicForm__mono" value={repoBranch} onChange={(e) => setRepoBranch(e.target.value)} autoComplete="off" spellCheck={false} />
                )}
              </FormField>
              <label className="TopicForm__check">
                <input type="checkbox" checked={repoPull} onChange={(e) => setRepoPull(e.target.checked)} />
                <span>Pull existing content from this repository into the new topic</span>
              </label>
            </>
          ) : null}
        </div>
      </details>
    </EditDialog>
  );
}
