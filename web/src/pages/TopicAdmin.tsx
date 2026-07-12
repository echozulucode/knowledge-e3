import { FormEvent, useMemo, useState } from 'react';
import { useArchiveTopic, useCreateTopic, useTopics, useUpdateTopic, type Topic } from '../queries.js';
import { Icon, appIcons } from '../icons.js';
import { AdminTabs } from '../components/admin/AdminTabs.js';
import './TopicAdmin.css';

function topicDisplayName(topic: Topic): string {
  return topic.name.trim() || topic.slug;
}

function topicItemCount(topic: Topic): number {
  return topic.counts?.items ?? 0;
}

function pluralizeItem(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

function errorToMessage(error: unknown, fallback: string): string {
  return error && typeof error === 'object' && 'message' in error
    ? String((error as { message?: unknown }).message)
    : fallback;
}

export function TopicAdmin() {
  const { data: topics = [], isLoading, isError, error, refetch } = useTopics();
  const createTopic = useCreateTopic();
  const updateTopic = useUpdateTopic();
  const archiveTopic = useArchiveTopic();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingTopic, setEditingTopic] = useState<Topic | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [repoBranch, setRepoBranch] = useState('');
  const [repoPull, setRepoPull] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const sortedTopics = useMemo(
    () => [...topics].sort((a, b) => topicDisplayName(a).localeCompare(topicDisplayName(b), undefined, { sensitivity: 'base' })),
    [topics],
  );
  const describedTopics = sortedTopics.filter((topic) => topic.description && topic.description.trim().length > 0).length;
  const totalItems = sortedTopics.reduce((sum, topic) => sum + topicItemCount(topic), 0);
  const listErrorMessage = errorToMessage(error, 'Unable to load topics.');
  const mutationError = errorToMessage(createTopic.error ?? updateTopic.error ?? archiveTopic.error, 'Unable to save topic.');
  const canCreate = name.trim().length > 0 && !createTopic.isPending;
  const canSaveEdit = name.trim().length > 0 && !updateTopic.isPending;

  function closeCreate() {
    if (createTopic.isPending) return;
    setIsCreateOpen(false);
    setName('');
    setSlug('');
    setDescription('');
    setRepoUrl('');
    setRepoBranch('');
    setRepoPull(true);
  }

  function openRename(topic: Topic) {
    setEditingTopic(topic);
    setName(topicDisplayName(topic));
    setDescription(topic.description ?? '');
    setMessage(null);
  }

  function closeRename() {
    if (updateTopic.isPending) return;
    setEditingTopic(null);
    setName('');
    setDescription('');
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) return;

    try {
      const topic = await createTopic.mutateAsync({
        name: name.trim(),
        slug: slug.trim() || undefined,
        description: description.trim() || undefined,
        repo: repoUrl.trim()
          ? { remote_url: repoUrl.trim(), branch: repoBranch.trim() || undefined, pull: repoPull }
          : undefined,
      });
      closeCreate();
      setMessage(
        repoUrl.trim()
          ? `Topic created: ${topic.name} (bound to a dedicated repository${repoPull ? ', pulling its content' : ''})`
          : `Topic created: ${topic.name}`,
      );
    } catch {
      // TanStack Query exposes the error through createTopic.error for inline rendering.
    }
  }

  async function handleRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingTopic || !canSaveEdit) return;
    try {
      const topic = await updateTopic.mutateAsync({ id: editingTopic.id, name: name.trim(), description: description.trim() || undefined });
      closeRename();
      setMessage(`Topic saved: ${topic.name}`);
    } catch {
      // Inline mutation error is rendered below the dialog.
    }
  }

  async function handleArchive(topic: Topic) {
    try {
      await archiveTopic.mutateAsync(topic.id);
      setMessage(`Topic archived: ${topicDisplayName(topic)}`);
    } catch {
      // Inline mutation error is rendered below actions.
    }
  }

  return (
    <main className="TopicAdmin" aria-labelledby="topic-admin-title">
      <AdminTabs />
      <section className="TopicAdmin__hero">
        <div className="TopicAdmin__eyebrow">
          <Icon icon={appIcons.layerGroup} />
          <span>Admin catalog</span>
        </div>
        <div className="TopicAdmin__heroGrid">
          <div>
            <h1 id="topic-admin-title">Spaces</h1>
            <p>
              Manage the Space catalog separately from article editing. Spaces are the top-level containers for
              articles; reassignment stays out of the editor while Admin handles catalog-level changes.
            </p>
          </div>
          <div className="TopicAdmin__stats" aria-label="Topic summary">
            <strong>{sortedTopics.length}</strong>
            <span>topics</span>
            <strong>{totalItems}</strong>
            <span>assigned items</span>
            <strong>{describedTopics}</strong>
            <span>with descriptions</span>
          </div>
        </div>
      </section>

      <section className="TopicAdmin__panel" aria-live="polite">
        <div className="TopicAdmin__sectionHeader">
          <div>
            <h2>Existing Topics</h2>
            <p>Catalog entries exposed by the current backend Topic API with item counts.</p>
          </div>
          <button type="button" className="TopicAdmin__refresh" onClick={() => void refetch()}>
            Refresh
          </button>
        </div>

        {isLoading ? (
          <div className="TopicAdmin__state" role="status">
            <span className="TopicAdmin__spinner" aria-hidden="true" />
            Loading Topics…
          </div>
        ) : isError ? (
          <div className="TopicAdmin__state TopicAdmin__state--error" role="alert">
            <strong>Space catalog unavailable</strong>
            <span>{listErrorMessage}</span>
            <button type="button" onClick={() => void refetch()}>Try again</button>
          </div>
        ) : sortedTopics.length === 0 ? (
          <div className="TopicAdmin__state">
            <strong>No Spaces yet</strong>
            <span>Create the first Space from the action panel below; articles will keep their initial Space assignment.</span>
          </div>
        ) : (
          <table className="TopicAdmin__table" aria-label="Space catalog">
            <thead>
              <tr>
                <th scope="col">Space</th>
                <th scope="col">Slug</th>
                <th scope="col">Description</th>
                <th scope="col">Items</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedTopics.map((topic) => {
                const itemCount = topicItemCount(topic);
                return (
                  <tr key={topic.id}>
                    <td>{topicDisplayName(topic)}</td>
                    <td><code>{topic.slug}</code></td>
                    <td>{topic.description || '—'}</td>
                    <td>{pluralizeItem(itemCount)}</td>
                    <td><span className="TopicAdmin__badge">Active</span></td>
                    <td>
                      <div className="TopicAdmin__rowActions">
                        <button type="button" onClick={() => openRename(topic)} aria-label={`Rename topic ${topicDisplayName(topic)}`}>
                          <Icon icon={appIcons.pencil} /> Rename
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleArchive(topic)}
                          disabled={itemCount > 0 || archiveTopic.isPending}
                          aria-label={`Archive topic ${topicDisplayName(topic)}`}
                          title={itemCount > 0 ? 'Topics with assigned items cannot be archived.' : 'Archive topic'}
                        >
                          <Icon icon={appIcons.xmark} /> Archive
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="TopicAdmin__panel" aria-label="Topic actions">
        <div>
          <h2>Catalog actions</h2>
          <p>Create new catalog entries, rename safe display metadata, and archive unused Topics once they are empty.</p>
        </div>
        <div className="TopicAdmin__actions">
          <button type="button" onClick={() => setIsCreateOpen(true)}>
            <Icon icon={appIcons.plus} />
            New Topic
          </button>
        </div>
        <p id="topic-admin-defer-note" className="TopicAdmin__deferNote">
          Topics with assigned items cannot be archived. Article Topic reassignment remains out of the current MVP editor path.
        </p>
        {message ? <p className="TopicAdmin__success" role="status">{message}</p> : null}
        {(createTopic.isError || updateTopic.isError || archiveTopic.isError) ? (
          <p className="TopicAdmin__error" role="alert">{mutationError}</p>
        ) : null}
      </section>

      {isCreateOpen ? (
        <div className="TopicAdmin__modalBackdrop">
          <section className="TopicAdmin__modal" role="dialog" aria-modal="true" aria-labelledby="topic-create-title">
            <div className="TopicAdmin__modalHeader">
              <div>
                <h2 id="topic-create-title">New Topic</h2>
                <p>Create a catalog entry using the backend-supported Topic fields.</p>
              </div>
              <button type="button" className="TopicAdmin__iconButton" onClick={closeCreate} aria-label="Close new topic dialog">
                <Icon icon={appIcons.xmark} />
              </button>
            </div>
            <form className="TopicAdmin__form" onSubmit={(event) => void handleCreate(event)}>
              <label>
                <span>Space name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required />
              </label>
              <label>
                <span>Space slug</span>
                <input value={slug} onChange={(event) => setSlug(event.target.value)} maxLength={100} placeholder="auto-generated if blank" />
              </label>
              <label className="TopicAdmin__formWide">
                <span>Description</span>
                <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} rows={3} />
              </label>
              <label className="TopicAdmin__formWide">
                <span>Dedicated git repo (optional)</span>
                <input
                  value={repoUrl}
                  onChange={(event) => setRepoUrl(event.target.value)}
                  placeholder="Leave blank to use the main repo; or git@host:org/topic.git"
                />
              </label>
              {repoUrl.trim() ? (
                <>
                  <label>
                    <span>Branch (optional)</span>
                    <input value={repoBranch} onChange={(event) => setRepoBranch(event.target.value)} placeholder="(current)" />
                  </label>
                  <label className="TopicAdmin__formWide" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
                    <input type="checkbox" checked={repoPull} onChange={(event) => setRepoPull(event.target.checked)} />
                    <span>Pull existing content from this repo into the new topic</span>
                  </label>
                </>
              ) : null}
              <div className="TopicAdmin__modalActions">
                <button type="button" onClick={closeCreate} disabled={createTopic.isPending}>Cancel</button>
                <button type="submit" disabled={!canCreate}>
                  <Icon icon={appIcons.plus} />
                  {createTopic.isPending ? 'Creating…' : 'Create Topic'}
                </button>
              </div>
            </form>
            {createTopic.isError ? <p className="TopicAdmin__error" role="alert">{mutationError}</p> : null}
          </section>
        </div>
      ) : null}

      {editingTopic ? (
        <div className="TopicAdmin__modalBackdrop">
          <section className="TopicAdmin__modal" role="dialog" aria-modal="true" aria-labelledby="topic-rename-title">
            <div className="TopicAdmin__modalHeader">
              <div>
                <h2 id="topic-rename-title">Rename Topic</h2>
                <p>Update the display name and description. Slugs and assigned items stay unchanged.</p>
              </div>
              <button type="button" className="TopicAdmin__iconButton" onClick={closeRename} aria-label="Close rename topic dialog">
                <Icon icon={appIcons.xmark} />
              </button>
            </div>
            <form className="TopicAdmin__form" onSubmit={(event) => void handleRename(event)}>
              <label>
                <span>Space name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required />
              </label>
              <label className="TopicAdmin__formWide">
                <span>Description</span>
                <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} rows={3} />
              </label>
              <div className="TopicAdmin__modalActions">
                <button type="button" onClick={closeRename} disabled={updateTopic.isPending}>Cancel</button>
                <button type="submit" disabled={!canSaveEdit}>{updateTopic.isPending ? 'Saving…' : 'Save Topic'}</button>
              </div>
            </form>
            {updateTopic.isError ? <p className="TopicAdmin__error" role="alert">{mutationError}</p> : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}
