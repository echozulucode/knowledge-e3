/**
 * TopicsIndex — `/topics`: one tile per visible topic (name, description, item
 * count, presentation chip), flat and sorted by name. Each links to its landing page.
 */
import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { useTopics } from '../../queries.js';
import { Icon, appIcons } from '../../icons.js';
import type { TopicListEntry } from './queries.js';
import './TopicsIndex.css';

export function TopicsIndex() {
  const { data, isLoading, isError } = useTopics();
  const topics = useMemo(
    () => [...((data ?? []) as TopicListEntry[])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [data],
  );

  return (
    <main className="TopicsIndex" aria-labelledby="topic-topicsindex-title">
      <header className="TopicsIndex__hero">
        <span className="TopicsIndex__eyebrow"><Icon icon={appIcons.layerGroup} fixedWidth={false} /> Topics</span>
        <h1 id="topic-topicsindex-title">Topics</h1>
        <p>Every topic you can read. Open one for its guidance, examples, and latest items.</p>
      </header>

      {isLoading ? (
        <p className="TopicsIndex__muted">Loading…</p>
      ) : isError ? (
        <p className="TopicsIndex__muted" role="alert">Could not load topics.</p>
      ) : topics.length === 0 ? (
        <div className="TopicsIndex__empty">No topics yet.</div>
      ) : (
        <div className="TopicsIndex__grid" role="list">
          {topics.map((t) => (
            <Link key={t.id} to="/topics/$slug" params={{ slug: t.slug }} className="TopicsIndex__tile" role="listitem">
              <div className="TopicsIndex__tileHead">
                <h2>{t.name.trim() || t.slug}</h2>
                <span className="TopicsIndex__chip" data-presentation={t.presentation ?? 'wiki'}>{t.presentation ?? 'wiki'}</span>
              </div>
              {t.description ? <p>{t.description}</p> : null}
              <span className="TopicsIndex__count">{t.counts?.items ?? 0} {t.counts?.items === 1 ? 'item' : 'items'}</span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
