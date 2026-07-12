import { FormEvent, useMemo, useState } from 'react';
import { useCreateGroup, useGroups, useTags, useTopics, type TaxonomyGroup, type TaxonomyTag } from '../queries.js';
import { Icon, appIcons } from '../icons.js';
import { AdminTabs } from '../components/admin/AdminTabs.js';
import './TopicAdmin.css';

function pluralizeItem(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

function scopeLabel(group: TaxonomyGroup): string {
  if (group.scope.type === 'global') return 'Global';
  return group.scope.space_slug ? `Topic: ${group.scope.space_slug}` : 'Topic-scoped';
}

function errorToMessage(error: unknown, fallback: string): string {
  return error && typeof error === 'object' && 'message' in error
    ? String((error as { message?: unknown }).message)
    : fallback;
}

export function TagGroupAdmin() {
  const [query, setQuery] = useState('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupSlug, setGroupSlug] = useState('');
  const [groupDescription, setGroupDescription] = useState('');
  const [scope, setScope] = useState<'global' | 'space'>('global');
  const [spaceId, setSpaceId] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const { data: tags = [], isLoading: tagsLoading, isError: tagsError, error: tagError, refetch: refetchTags } = useTags(query);
  const { data: groups = [], isLoading: groupsLoading, isError: groupsError, error: groupError, refetch: refetchGroups } = useGroups(query);
  const { data: topics = [] } = useTopics();
  const createGroup = useCreateGroup();

  const sortedTags = useMemo(
    () => [...tags].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [tags],
  );
  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [groups],
  );
  const totalTagAssignments = sortedTags.reduce((sum, tag) => sum + tag.count, 0);
  const totalGroupAssignments = sortedGroups.reduce((sum, group) => sum + group.count, 0);
  const canCreate = groupName.trim().length > 0 && (scope === 'global' || spaceId.length > 0) && !createGroup.isPending;
  const mutationError = errorToMessage(createGroup.error, 'Unable to create group.');

  function closeCreate() {
    if (createGroup.isPending) return;
    setIsCreateOpen(false);
    setGroupName('');
    setGroupSlug('');
    setGroupDescription('');
    setScope('global');
    setSpaceId('');
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) return;
    try {
      const group = await createGroup.mutateAsync({
        name: groupName.trim(),
        slug: groupSlug.trim() || undefined,
        description: groupDescription.trim() || undefined,
        scope,
        space_id: scope === 'space' ? spaceId : undefined,
      });
      closeCreate();
      setMessage(`Group created: ${group.name}`);
    } catch {
      // TanStack Query exposes the mutation error for inline rendering.
    }
  }

  return (
    <main className="TopicAdmin" aria-labelledby="tag-group-admin-title">
      <AdminTabs />
      <section className="TopicAdmin__hero">
        <div className="TopicAdmin__eyebrow">
          <Icon icon={appIcons.tag} />
          <span>Admin taxonomy</span>
        </div>
        <div className="TopicAdmin__heroGrid">
          <div>
            <h1 id="tag-group-admin-title">Tags and groups</h1>
            <p>
              Review derived tag usage, manage backend-supported groups, and keep risky taxonomy rewrites out of the
              everyday item editor.
            </p>
          </div>
          <div className="TopicAdmin__stats" aria-label="Tag and group summary">
            <strong>{sortedTags.length}</strong>
            <span>tags</span>
            <strong>{totalTagAssignments}</strong>
            <span>tag assignments</span>
            <strong>{sortedGroups.length}</strong>
            <span>groups</span>
            <strong>{totalGroupAssignments}</strong>
            <span>group assignments</span>
          </div>
        </div>
      </section>

      <section className="TopicAdmin__panel" aria-label="Taxonomy search">
        <div className="TopicAdmin__sectionHeader">
          <div>
            <h2>Search taxonomy</h2>
            <p>Filter tag and group picker catalogs by name, slug, or topic scope.</p>
          </div>
          <button type="button" className="TopicAdmin__refresh" onClick={() => { void refetchTags(); void refetchGroups(); }}>
            Refresh
          </button>
        </div>
        <label className="TopicAdmin__formWide">
          <span>Search tags and groups</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, slug, or topic" />
        </label>
      </section>

      <section className="TopicAdmin__panel" aria-live="polite">
        <div className="TopicAdmin__sectionHeader">
          <div>
            <h2>Tags</h2>
            <p>Tags are derived from existing item frontmatter and are exposed to item-editor pickers.</p>
          </div>
        </div>
        {tagsLoading ? (
          <div className="TopicAdmin__state" role="status">Loading tags…</div>
        ) : tagsError ? (
          <div className="TopicAdmin__state TopicAdmin__state--error" role="alert">{errorToMessage(tagError, 'Unable to load tags.')}</div>
        ) : sortedTags.length === 0 ? (
          <div className="TopicAdmin__state">No tags match this filter.</div>
        ) : (
          <table className="TopicAdmin__table" aria-label="Tag catalog">
            <thead>
              <tr><th scope="col">Tag</th><th scope="col">Slug</th><th scope="col">Usage</th><th scope="col">Actions</th></tr>
            </thead>
            <tbody>
              {sortedTags.map((tag: TaxonomyTag) => (
                <tr key={tag.id}>
                  <td>{tag.name}</td>
                  <td><code>{tag.slug}</code></td>
                  <td>{pluralizeItem(tag.count)}</td>
                  <td>
                    <div className="TopicAdmin__rowActions">
                      <button type="button" disabled title="Tag rename is deferred until a safe item rewrite flow is available."><Icon icon={appIcons.pencil} /> Rename</button>
                      <button type="button" disabled title="Tag archive/restore is deferred because tags are derived from item frontmatter."><Icon icon={appIcons.xmark} /> Archive</button>
                      <button type="button" disabled title="Tag merge is deferred until bulk rewrite review exists."><Icon icon={appIcons.layerGroup} /> Merge</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="TopicAdmin__panel" aria-live="polite">
        <div className="TopicAdmin__sectionHeader">
          <div>
            <h2>Groups</h2>
            <p>Groups can be global or scoped to a Topic where the backend supports it.</p>
          </div>
          <button type="button" onClick={() => setIsCreateOpen(true)}><Icon icon={appIcons.plus} /> New group</button>
        </div>
        {groupsLoading ? (
          <div className="TopicAdmin__state" role="status">Loading groups…</div>
        ) : groupsError ? (
          <div className="TopicAdmin__state TopicAdmin__state--error" role="alert">{errorToMessage(groupError, 'Unable to load groups.')}</div>
        ) : sortedGroups.length === 0 ? (
          <div className="TopicAdmin__state">No groups match this filter.</div>
        ) : (
          <table className="TopicAdmin__table" aria-label="Group catalog">
            <thead>
              <tr><th scope="col">Group</th><th scope="col">Slug</th><th scope="col">Scope</th><th scope="col">Usage</th><th scope="col">Actions</th></tr>
            </thead>
            <tbody>
              {sortedGroups.map((group) => (
                <tr key={group.id}>
                  <td>{group.name}</td>
                  <td><code>{group.slug}</code></td>
                  <td>{scopeLabel(group)}</td>
                  <td>{pluralizeItem(group.count)}</td>
                  <td>
                    <div className="TopicAdmin__rowActions">
                      <button type="button" disabled title="Group rename is deferred until assignment rewrite review exists."><Icon icon={appIcons.pencil} /> Rename</button>
                      <button type="button" disabled title="Archive/restore is deferred until restore semantics are implemented."><Icon icon={appIcons.xmark} /> Archive</button>
                      <button type="button" disabled title="Group merge is deferred until bulk rewrite review exists."><Icon icon={appIcons.layerGroup} /> Merge</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p id="tag-group-admin-defer-note" className="TopicAdmin__deferNote">
          Unsafe tag/group rename, archive/restore, and merge operations are disabled until a reviewed bulk item rewrite flow exists.
        </p>
        {message ? <p className="TopicAdmin__success" role="status">{message}</p> : null}
      </section>

      {isCreateOpen ? (
        <div className="TopicAdmin__modalBackdrop">
          <section className="TopicAdmin__modal" role="dialog" aria-modal="true" aria-labelledby="group-create-title">
            <div className="TopicAdmin__modalHeader">
              <div>
                <h2 id="group-create-title">New group</h2>
                <p>Create a backend group for item-editor pickers.</p>
              </div>
              <button type="button" className="TopicAdmin__iconButton" onClick={closeCreate} aria-label="Close new group dialog"><Icon icon={appIcons.xmark} /></button>
            </div>
            <form className="TopicAdmin__form" onSubmit={(event) => void handleCreate(event)}>
              <label><span>Group name</span><input value={groupName} onChange={(event) => setGroupName(event.target.value)} maxLength={200} required /></label>
              <label><span>Group slug</span><input value={groupSlug} onChange={(event) => setGroupSlug(event.target.value)} maxLength={100} placeholder="auto-generated if blank" /></label>
              <label><span>Scope</span><select value={scope} onChange={(event) => setScope(event.target.value as 'global' | 'space')}><option value="global">Global</option><option value="space">Topic-scoped</option></select></label>
              {scope === 'space' ? (
                <label><span>Space</span><select value={spaceId} onChange={(event) => setSpaceId(event.target.value)} required><option value="">Choose a space</option>{topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}</select></label>
              ) : null}
              <label className="TopicAdmin__formWide"><span>Description</span><textarea value={groupDescription} onChange={(event) => setGroupDescription(event.target.value)} maxLength={1000} rows={3} /></label>
              <div className="TopicAdmin__modalActions">
                <button type="button" onClick={closeCreate} disabled={createGroup.isPending}>Cancel</button>
                <button type="submit" disabled={!canCreate}><Icon icon={appIcons.plus} /> {createGroup.isPending ? 'Creating…' : 'Create group'}</button>
              </div>
            </form>
            {createGroup.isError ? <p className="TopicAdmin__error" role="alert">{mutationError}</p> : null}
          </section>
        </div>
      ) : null}
    </main>
  );
}
