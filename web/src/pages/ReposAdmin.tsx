/**
 * ReposAdmin — backend git repositories (ADR-0001 multi-repo). Admin-only.
 * Configure the instance "main repo" remote (where topics live by default), bind
 * individual topics to dedicated repos, check connectivity, and Sync now to push
 * existing content. Credentials are never entered here — pushes use the host's
 * ambient SSH identity.
 */
import { useEffect, useState } from 'react';
import {
  useTopics,
  useRepos,
  useUpsertRepo,
  useRemoveRepo,
  useTestRepoConnection,
  useSetMainRemote,
  useSyncRepo,
  usePullRepo,
  type Topic,
} from '../queries.js';
import { AdminTabs } from '../components/admin/AdminTabs.js';
import { Icon, appIcons } from '../icons.js';
import './OkfAdmin.css';

interface RowState {
  remote_url: string;
  branch: string;
  enabled: boolean;
  test?: { ok: boolean; message: string };
  synced?: number;
}

export function ReposAdmin() {
  const { data, isLoading } = useRepos();
  const repos = data?.repos ?? [];
  const { data: topics = [] } = useTopics();
  const upsert = useUpsertRepo();
  const remove = useRemoveRepo();
  const testConn = useTestRepoConnection();
  const setMain = useSetMainRemote();
  const sync = useSyncRepo();
  const pull = usePullRepo();

  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [mainUrl, setMainUrl] = useState('');
  const [mainBranch, setMainBranch] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const next: Record<string, RowState> = {};
    for (const r of repos) next[r.space_id] = { remote_url: r.remote_url, branch: r.branch ?? '', enabled: r.enabled };
    setRows((prev) => ({ ...next, ...keepEdited(prev, next) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    if (data?.main) {
      setMainUrl(data.main.remote_url);
      setMainBranch(data.main.branch ?? '');
    }
  }, [data]);

  const rowFor = (id: string): RowState => rows[id] ?? { remote_url: '', branch: '', enabled: true };
  const update = (id: string, patch: Partial<RowState>) =>
    setRows((prev) => ({ ...prev, [id]: { ...rowFor(id), ...patch } }));

  async function saveMain() {
    setMessage(null);
    if (!mainUrl.trim()) return;
    await setMain.mutateAsync({ remote_url: mainUrl.trim(), branch: mainBranch.trim() || undefined, enabled: true });
    setMessage('Saved main repository remote.');
  }

  async function saveTopic(topic: Topic) {
    setMessage(null);
    const row = rowFor(topic.id);
    if (!row.remote_url.trim()) return;
    await upsert.mutateAsync({ space_id: topic.id, remote_url: row.remote_url.trim(), branch: row.branch.trim() || undefined, enabled: row.enabled });
    setMessage(`Bound ${topic.name} to a dedicated repository.`);
  }

  async function test(topic: Topic) {
    const result = await testConn.mutateAsync(rowFor(topic.id).remote_url.trim());
    update(topic.id, { test: result });
  }

  async function syncTopic(topic: Topic) {
    const result = await sync.mutateAsync(topic.id);
    update(topic.id, { synced: result.items });
    setMessage(`Synced ${result.items} item(s) from ${topic.name} → repo.`);
  }

  async function pullTopic(topic: Topic) {
    setMessage(null);
    try {
      const result = await pull.mutateAsync(topic.id);
      setMessage(`Pulled ${topic.name} ← repo: ${result.created} created, ${result.updated} updated.`);
    } catch (err) {
      setMessage(
        `Pull failed: ${err && typeof err === 'object' && 'message' in err ? String((err as { message?: unknown }).message) : 'error'}`,
      );
    }
  }

  return (
    <main className="OkfAdmin" aria-labelledby="repos-admin-title">
      <AdminTabs />
      <section className="OkfAdmin__hero">
        <div className="OkfAdmin__eyebrow">
          <Icon icon={appIcons.sliders} />
          <span>Admin data</span>
        </div>
        <h1 id="repos-admin-title">Backend repositories</h1>
        <p>
          Topics live in the <strong>main repository</strong> by default (each as a subfolder), or you
          can bind a topic to its own <strong>dedicated repository</strong>. Set <code>GIT_MIRROR_ROOT</code>
          on the server to enable mirroring. <strong>Keys are never entered here</strong> — pushes use the
          server's ambient SSH identity. Use <strong>Sync now</strong> to push existing content after
          configuring a remote.
        </p>
      </section>

      <section className="OkfAdmin__panel">
        <h2>Main repository</h2>
        <p>Where every topic is pushed unless it has a dedicated repo of its own.</p>
        <label className="OkfAdmin__field">
          <span>Remote URL</span>
          <input value={mainUrl} onChange={(e) => setMainUrl(e.target.value)} placeholder="git@host:org/knowledge.git" />
        </label>
        <label className="OkfAdmin__field">
          <span>Branch (optional)</span>
          <input value={mainBranch} onChange={(e) => setMainBranch(e.target.value)} placeholder="(current)" />
        </label>
        <div className="OkfAdmin__actions">
          <button type="button" onClick={() => void saveMain()} disabled={setMain.isPending}>
            <Icon icon={appIcons.floppyDisk} /> Save main remote
          </button>
        </div>
      </section>

      <section className="OkfAdmin__panel">
        <h2>Space → repository</h2>
        {isLoading ? (
          <p>Loading topics…</p>
        ) : topics.length === 0 ? (
          <p className="OkfAdmin__muted">No topics yet — create one in Taxonomy → Topics (you can bind a repo there too).</p>
        ) : (
          <table className="OkfAdmin__table">
            <thead>
              <tr>
                <th>Space</th>
                <th>Dedicated remote (optional)</th>
                <th>Branch</th>
                <th>On</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {topics.map((topic) => {
                const row = rowFor(topic.id);
                const mapped = repos.some((r) => r.space_id === topic.id);
                return (
                  <tr key={topic.id}>
                    <td>{topic.name}</td>
                    <td>
                      <input
                        value={row.remote_url}
                        onChange={(e) => update(topic.id, { remote_url: e.target.value })}
                        placeholder="(uses main repo)"
                      />
                      {row.test ? (
                        <div className={row.test.ok ? 'OkfAdmin__success' : 'OkfAdmin__error'}>
                          {row.test.ok ? '✓ ' : '✗ '}{row.test.message}
                        </div>
                      ) : null}
                    </td>
                    <td><input value={row.branch} onChange={(e) => update(topic.id, { branch: e.target.value })} placeholder="(current)" /></td>
                    <td><input type="checkbox" checked={row.enabled} onChange={(e) => update(topic.id, { enabled: e.target.checked })} /></td>
                    <td>
                      <div className="OkfAdmin__actions">
                        <button type="button" onClick={() => void saveTopic(topic)} disabled={upsert.isPending}>Save</button>
                        <button type="button" onClick={() => void test(topic)} disabled={!row.remote_url.trim() || testConn.isPending}>Test</button>
                        <button type="button" onClick={() => void syncTopic(topic)} disabled={sync.isPending} title="Push E3 items → repo">Sync now</button>
                        {mapped ? (
                          <>
                            <button type="button" onClick={() => void pullTopic(topic)} disabled={pull.isPending} title="Import the repo's content → this topic">Pull from repo</button>
                            <button type="button" onClick={() => void remove.mutateAsync(topic.id)} title="Unbind dedicated repo">
                              <Icon icon={appIcons.xmark} />
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {message ? <p className="OkfAdmin__success" role="status">{message}</p> : null}
      </section>
    </main>
  );
}

/** Keep in-progress edits for rows the user is actively changing across refetches. */
function keepEdited(prev: Record<string, RowState>, saved: Record<string, RowState>): Record<string, RowState> {
  const edited: Record<string, RowState> = {};
  for (const [id, row] of Object.entries(prev)) {
    if (!saved[id] && row.remote_url) edited[id] = row;
  }
  return edited;
}
