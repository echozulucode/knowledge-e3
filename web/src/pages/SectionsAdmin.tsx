/**
 * SectionsAdmin — curate "sections": named views over a concept kind (OKF `type`)
 * and/or a topic (space). Sections give purpose-specific landing pages (blogs,
 * FAQs, best practices) while staying OKF-aligned. Admin-only.
 */
import { useEffect, useState } from 'react';
import { useSections, useSaveSections, type Section } from '../queries.js';
import { AdminTabs } from '../components/admin/AdminTabs.js';
import { Icon, appIcons } from '../icons.js';
import './OkfAdmin.css';

type DraftSection = Section;

function blankSection(): DraftSection {
  return { slug: '', name: '', description: '', type: '', space: '' };
}

export function SectionsAdmin() {
  const { data: saved = [], isLoading } = useSections();
  const save = useSaveSections();
  const [rows, setRows] = useState<DraftSection[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setRows(saved.length ? saved.map((s) => ({ ...s })) : []);
  }, [saved]);

  function update(i: number, patch: Partial<DraftSection>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function remove(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }
  function add() {
    setRows((prev) => [...prev, blankSection()]);
  }

  async function onSave() {
    setMessage(null);
    const clean = rows
      .filter((r) => r.name.trim())
      .map((r) => ({
        name: r.name.trim(),
        slug: (r.slug || r.name).trim(),
        description: r.description?.trim() || undefined,
        type: r.type?.trim() || undefined,
        space: r.space?.trim() || undefined,
      }));
    const result = await save.mutateAsync(clean);
    setRows(result.map((s) => ({ ...s })));
    setMessage(`Saved ${result.length} section(s).`);
  }

  return (
    <main className="OkfAdmin" aria-labelledby="sections-admin-title">
      <AdminTabs />
      <section className="OkfAdmin__hero">
        <div className="OkfAdmin__eyebrow">
          <Icon icon={appIcons.layerGroup} />
          <span>Admin data</span>
        </div>
        <h1 id="sections-admin-title">Sections</h1>
        <p>
          A section is a curated view filtered by a concept <strong>type</strong> (the OKF kind, e.g.
          <code> blog</code>, <code>faq</code>, <code>best-practice</code>) and/or a <strong>topic</strong>.
          Leave a filter blank to ignore it. Sections appear under <code>/sections</code>.
        </p>
      </section>

      <section className="OkfAdmin__panel">
        <h2>Defined sections</h2>
        {isLoading ? (
          <p>Loading…</p>
        ) : (
          <table className="OkfAdmin__table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Type</th>
                <th>Space</th>
                <th>Description</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="OkfAdmin__muted">No sections yet — add one below.</td>
                </tr>
              ) : (
                rows.map((r, i) => (
                  <tr key={i}>
                    <td><input value={r.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Blog" /></td>
                    <td><input value={r.slug} onChange={(e) => update(i, { slug: e.target.value })} placeholder="auto" /></td>
                    <td><input value={r.type ?? ''} onChange={(e) => update(i, { type: e.target.value })} placeholder="blog" /></td>
                    <td><input value={r.space ?? ''} onChange={(e) => update(i, { space: e.target.value })} placeholder="topic slug" /></td>
                    <td><input value={r.description ?? ''} onChange={(e) => update(i, { description: e.target.value })} /></td>
                    <td>
                      <button type="button" onClick={() => remove(i)} aria-label={`Remove ${r.name || 'section'}`}>
                        <Icon icon={appIcons.xmark} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
        <div className="OkfAdmin__actions">
          <button type="button" onClick={add}><Icon icon={appIcons.plus} /> Add section</button>
          <button type="button" onClick={() => void onSave()} disabled={save.isPending}>
            <Icon icon={appIcons.floppyDisk} /> {save.isPending ? 'Saving…' : 'Save sections'}
          </button>
        </div>
        {message ? <p className="OkfAdmin__success" role="status">{message}</p> : null}
        {save.isError ? <p className="OkfAdmin__error" role="alert">Failed to save sections.</p> : null}
      </section>
    </main>
  );
}
