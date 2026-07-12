/**
 * Home — the signature landing surface, in the mock's editorial layout:
 *   Hero panel (scope eyebrow + calm headline + lead + actions)
 *   + Workspace pulse (stat panel)
 *   → Featured card grid
 *   → Recently-updated row list
 *
 * Scope-aware, source-backed, calm. Backed by real pages/topics/types.
 */
import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMe, usePages, useTopics, useContentTypes, type Page } from '../queries.js';
import { ContentTypeBadge } from '../components/ContentTypeBadge.js';
import { Icon, appIcons } from '../icons.js';
import './Home.css';

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '';
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function StatusBadge({ status }: { status: Page['status'] }) {
  return (
    <span className={`Home__status Home__status--${status}`}>
      {status === 'published' ? 'Published' : 'Draft'}
    </span>
  );
}

export function Home() {
  const navigate = useNavigate();
  const { data: user } = useMe();
  const canWrite = !!user;
  const { data: pages = [], isLoading } = usePages({ limit: 1000 });
  const { data: topics = [] } = useTopics();
  const { data: contentTypes = [] } = useContentTypes();
  const [query, setQuery] = useState('');

  const topicName = useMemo(() => {
    const byId = new Map(topics.map((t) => [t.id, t.name]));
    return (p: Page) => {
      if (p.space_id && byId.has(p.space_id)) return byId.get(p.space_id)!;
      const fm = p.frontmatter as Record<string, unknown> | undefined;
      return typeof fm?.['topic'] === 'string' ? (fm['topic'] as string) : 'Default space';
    };
  }, [topics]);

  const recent = useMemo(
    () => [...pages].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()),
    [pages],
  );
  const featured = useMemo(() => {
    const published = recent.filter((p) => p.status === 'published');
    return (published.length ? published : recent).slice(0, 6);
  }, [recent]);

  const stats = [
    { value: pages.length, label: 'Objects' },
    { value: pages.filter((p) => p.status === 'draft').length, label: 'Drafts' },
    { value: topics.length, label: 'Spaces' },
    { value: contentTypes.length, label: 'Content types' },
  ];

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    navigate({ to: '/browse', search: { view: 'grouped', ...(q ? { q } : {}) } as any });
  };

  const DocCard = ({ page }: { page: Page }) => (
    <Link to="/items/$id" params={{ id: page.id }} className="Home__card">
      <div className="Home__cardHead">
        {page.type ? <ContentTypeBadge type={page.type} size="sm" /> : <span />}
        <StatusBadge status={page.status} />
      </div>
      <div className="Home__cardMain">
        <h3>{page.title}</h3>
        {frontmatterSummary(page) ? <p>{frontmatterSummary(page)}</p> : null}
      </div>
      <div className="Home__cardMeta">
        <span>{topicName(page)}</span>
        <span>·</span>
        <span>{relativeTime(page.updated_at)}</span>
      </div>
    </Link>
  );

  return (
    <main className="Home" aria-labelledby="home-title">
      {/* Hero + workspace pulse */}
      <section className="Home__hero">
        <div className="Home__heroPanel">
          <span className="Home__eyebrow">
            <Icon icon={appIcons.book} fixedWidth={false} /> Knowledge × 10<sup>3</sup> · OKF/Git-backed
          </span>
          <h1 id="home-title">Quiet, source-backed knowledge.</h1>
          <p className="Home__lead">
            Search, read, and organize OKF/Git-backed knowledge. The library scales through search and
            collections — not sprawling navigation — so it stays calm as it grows.
          </p>
          <form className="Home__search" onSubmit={onSearch} role="search">
            <span className="Home__searchIcon" aria-hidden="true"><Icon icon={appIcons.magnifyingGlass} fixedWidth={false} /></span>
            <input
              className="Home__searchInput"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search concepts, guides, FAQs, decisions…"
              aria-label="Search knowledge"
            />
            <button type="submit" className="Home__searchGo">Search</button>
          </form>
          <div className="Home__actions">
            <Link to="/browse" search={{ view: 'grouped' } as any} className="Home__btn">
              <Icon icon={appIcons.list} fixedWidth={false} /> Open library
            </Link>
            <Link to="/sections" className="Home__btn Home__btn--ghost">
              <Icon icon={appIcons.layerGroup} fixedWidth={false} /> Collections
            </Link>
            {canWrite && (
              <Link to="/browse" search={{ new: 'concept' } as any} className="Home__btn Home__btn--ghost">
                <Icon icon={appIcons.plus} fixedWidth={false} /> New item
              </Link>
            )}
          </div>
        </div>

        <aside className="Home__pulse">
          <h2>Workspace pulse</h2>
          <p>What this workspace currently holds and how much needs attention.</p>
          <div className="Home__statGrid">
            {stats.map((s) => (
              <div key={s.label} className="Home__stat">
                <b>{s.value}</b>
                <span>{s.label}</span>
              </div>
            ))}
          </div>
        </aside>
      </section>

      {/* Featured */}
      <div className="Home__sectionTitle">
        <div>
          <h2><Icon icon={appIcons.star} fixedWidth={false} /> Featured</h2>
          <p>A snapshot of current, high-signal objects in this workspace.</p>
        </div>
        <Link to="/browse" search={{ view: 'grouped' } as any} className="Home__seeAll">
          View all <Icon icon={appIcons.chevronRight} fixedWidth={false} />
        </Link>
      </div>
      {isLoading ? (
        <p className="Home__muted">Loading…</p>
      ) : featured.length === 0 ? (
        <div className="Home__empty">
          <p>No content yet.</p>
          {canWrite && (
            <Link to="/browse" search={{ new: 'concept' } as any} className="Home__btn">
              <Icon icon={appIcons.plus} fixedWidth={false} /> Create your first item
            </Link>
          )}
        </div>
      ) : (
        <div className="Home__cardGrid">
          {featured.map((p) => <DocCard key={p.id} page={p} />)}
        </div>
      )}

      {/* Recently updated */}
      {recent.length > 0 && (
        <>
          <div className="Home__sectionTitle">
            <div>
              <h2><Icon icon={appIcons.clock} fixedWidth={false} /> Recently updated</h2>
              <p>Rows scale better than clickable clouds as the library grows.</p>
            </div>
          </div>
          <div className="Home__rows">
            {recent.slice(0, 6).map((p) => (
              <Link key={p.id} to="/items/$id" params={{ id: p.id }} className="Home__row">
                <div className="Home__rowMain">
                  <div className="Home__rowBadges">
                    {p.type ? <ContentTypeBadge type={p.type} size="sm" /> : null}
                    <StatusBadge status={p.status} />
                  </div>
                  <h3>{p.title}</h3>
                  {frontmatterSummary(p) ? <p>{frontmatterSummary(p)}</p> : null}
                </div>
                <div className="Home__rowSide">
                  <span>{topicName(p)}</span>
                  <span>{relativeTime(p.updated_at)}</span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function frontmatterSummary(page: Page): string {
  const fm = page.frontmatter as Record<string, unknown> | undefined;
  const s = fm && typeof fm['summary'] === 'string' ? (fm['summary'] as string).trim() : '';
  if (s) return s;
  const body = (page.body_markdown || '')
    .replace(/^#+\s+.*$/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#*_`>[\]()!-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return body.slice(0, 150);
}
