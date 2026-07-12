/**
 * SpaceSwitcher — the breadcrumb-as-space-switcher from the mock.
 *
 * The active space shows in the top bar; clicking opens a searchable, grouped
 * popover (Recent · Favorites · Spaces). This is the scale-safe alternative to
 * pinning every repo/space in the sidebar — at 25→200 spaces you *search* here.
 * Backed by existing topics/spaces; recents & favorites persist in localStorage.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useTopics, type Topic } from '../../queries.js';
import { Icon, appIcons } from '../../icons.js';
import './SpaceSwitcher.css';

const RECENTS_KEY = 'kp-space-recents';
const FAV_KEY = 'kp-space-favorites';

function readList(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeList(key: string, list: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}
function mark(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || '?';
}

export function SpaceSwitcher() {
  const navigate = useNavigate();
  const { data: topics = [] } = useTopics();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState<string[]>(() => readList(FAV_KEY));
  const [recents, setRecents] = useState<string[]>(() => readList(RECENTS_KEY));
  const rootRef = useRef<HTMLDivElement>(null);

  const activeTopic = useRouterState({
    select: (s) => {
      const search = s.location.search as { topic?: unknown };
      return typeof search.topic === 'string' ? search.topic : undefined;
    },
  });
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const bySlug = useMemo(() => new Map(topics.map((t) => [t.slug, t])), [topics]);
  const activeLabel = useMemo(() => {
    if (activeTopic && bySlug.has(activeTopic)) return bySlug.get(activeTopic)!.name;
    if (pathname === '/') return 'Home';
    if (pathname.startsWith('/sections')) return 'Sections';
    return 'All spaces';
  }, [activeTopic, bySlug, pathname]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return topics;
    return topics.filter((t) => `${t.name} ${t.slug} ${t.description ?? ''}`.toLowerCase().includes(q));
  }, [topics, query]);

  const groups = useMemo(() => {
    const q = query.trim();
    const favSet = new Set(favorites);
    const recentTopics = recents.map((s) => bySlug.get(s)).filter((t): t is Topic => Boolean(t));
    const favTopics = topics.filter((t) => favSet.has(t.slug));
    // When searching, collapse to a single result group; otherwise show rails.
    if (q) return [{ label: `Results (${filtered.length})`, items: filtered }];
    return [
      ...(recentTopics.length ? [{ label: 'Recent', items: recentTopics.slice(0, 5) }] : []),
      ...(favTopics.length ? [{ label: 'Favorites', items: favTopics }] : []),
      { label: `All spaces (${topics.length})`, items: filtered },
    ];
  }, [query, filtered, favorites, recents, topics, bySlug]);

  function choose(t: Topic) {
    const next = [t.slug, ...recents.filter((s) => s !== t.slug)].slice(0, 6);
    setRecents(next);
    writeList(RECENTS_KEY, next);
    setOpen(false);
    setQuery('');
    void navigate({ to: '/browse', search: { view: 'grouped', topic: t.slug } as any });
  }

  function toggleFav(e: React.MouseEvent, slug: string) {
    e.stopPropagation();
    const next = favorites.includes(slug) ? favorites.filter((s) => s !== slug) : [...favorites, slug];
    setFavorites(next);
    writeList(FAV_KEY, next);
  }

  return (
    <div className="kp-switcher" ref={rootRef}>
      <button
        type="button"
        className="kp-switcher-crumb"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Switch space"
      >
        <span className="kp-switcher-mark">E3</span>
        <span className="kp-switcher-label">{activeLabel}</span>
        <Icon icon={appIcons.chevronRight} fixedWidth={false} />
      </button>

      {open && (
        <div className="kp-switcher-popover" role="dialog" aria-label="Switch space">
          <input
            className="kp-switcher-search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search spaces, repos…"
            aria-label="Search spaces"
          />
          <div className="kp-switcher-scroll">
            {topics.length === 0 ? (
              <p className="kp-switcher-empty">No spaces yet.</p>
            ) : (
              groups.map((g) => (
                <div key={g.label} className="kp-switcher-group">
                  <div className="kp-switcher-group-title">{g.label}</div>
                  {g.items.map((t) => (
                    <button key={t.slug} type="button" className={`kp-switcher-row ${activeTopic === t.slug ? 'active' : ''}`} onClick={() => choose(t)}>
                      <span className="kp-switcher-row-mark">{mark(t.name)}</span>
                      <span className="kp-switcher-row-copy">
                        <strong>{t.name}</strong>
                        <span>{t.counts?.items != null ? `${t.counts.items} objects` : 'Space'}{t.description ? ` · ${t.description}` : ''}</span>
                      </span>
                      <span
                        className={`kp-switcher-fav ${favorites.includes(t.slug) ? 'on' : ''}`}
                        onClick={(e) => toggleFav(e, t.slug)}
                        role="button"
                        aria-label={favorites.includes(t.slug) ? 'Unfavorite' : 'Favorite'}
                        title={favorites.includes(t.slug) ? 'Unfavorite' : 'Favorite'}
                      >
                        <Icon icon={appIcons.star} fixedWidth={false} />
                      </span>
                    </button>
                  ))}
                </div>
              ))
            )}
            <div className="kp-switcher-note">
              At 25–200 repos, spaces are searched and grouped here — not pinned in the sidebar.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
